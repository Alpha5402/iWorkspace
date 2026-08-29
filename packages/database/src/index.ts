import { type DependencyProbe } from '@delivery/health';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

import { type DatabaseSchema } from './schema.js';

export { sql };
export * from './schema.js';
export * from './identityEmailOutbox.js';
export * from './databaseClock.js';

type PostgresHealthClient = Readonly<{
  end(): Promise<void>;
  query(sql: string): Promise<unknown>;
}>;

type PostgresHealthClientFactory = (connectionString: string) => PostgresHealthClient;

const createDefaultClient: PostgresHealthClientFactory = (connectionString) =>
  new pg.Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 2 });

export function createPostgresProbe(
  connectionString: string,
  clientFactory: PostgresHealthClientFactory = createDefaultClient,
): DependencyProbe {
  const client = clientFactory(connectionString);

  return {
    name: 'postgres',
    async check() {
      try {
        await client.query('SELECT 1');
        return { name: 'postgres', status: 'up' };
      } catch {
        return { name: 'postgres', status: 'down' };
      }
    },
    async close() {
      await client.end();
    },
  };
}

export type DeliveryDatabase = Kysely<DatabaseSchema>;
export type DeliveryTransaction = Transaction<DatabaseSchema>;

export function createDatabase(connectionString: string, maxConnections = 20): DeliveryDatabase {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        connectionTimeoutMillis: 5_000,
        max: maxConnections,
      }),
    }),
  });
}

export function createPlatformAdminDatabase(
  connectionString: string,
  maxConnections = 5,
): DeliveryDatabase {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        connectionTimeoutMillis: 5_000,
        max: maxConnections,
        options: '-c role=iw_platform_admin',
      }),
    }),
  });
}

export async function withTenant<T>(
  database: DeliveryDatabase,
  organizationId: string,
  operation: (transaction: DeliveryTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction().execute(async (transaction) => {
    await setTenantContext(transaction, organizationId);
    return operation(transaction);
  });
}

export async function setTenantContext(
  transaction: DeliveryTransaction,
  organizationId: string,
): Promise<void> {
  await sql`select set_config('app.organization_id', ${organizationId}, true)`.execute(transaction);
}

export async function acquirePlatformAdminMutationLock(
  transaction: DeliveryTransaction,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended('iworkspace:platform-admin', 0))`.execute(
    transaction,
  );
}

export type OutboxEventInput = Readonly<{
  availableAt?: Date;
  causationId?: string;
  correlationId: string;
  eventId: string;
  eventType: string;
  organizationId: string;
  payload: Record<string, unknown>;
  projectId: string;
  traceparent?: string;
}>;

export async function insertOutboxEvent(
  transaction: DeliveryTransaction,
  event: OutboxEventInput,
): Promise<void> {
  await transaction
    .insertInto('outbox_events')
    .values({
      available_at: event.availableAt ?? new Date(),
      causation_id: event.causationId ?? null,
      claimed_by: null,
      claimed_until: null,
      correlation_id: event.correlationId,
      event_type: event.eventType,
      event_version: 1,
      id: event.eventId,
      last_error_code: null,
      occurred_at: new Date(),
      organization_id: event.organizationId,
      payload: event.payload,
      project_id: event.projectId,
      publish_attempts: 0,
      published_at: null,
      traceparent: event.traceparent ?? null,
    })
    .executeTakeFirstOrThrow();
}

export type ClaimedOutboxEvent = Readonly<{
  causationId?: string;
  correlationId: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date;
  organizationId: string;
  payload: Record<string, unknown>;
  projectId: string;
  traceparent?: string;
}>;

export async function claimOutboxEvents(
  database: DeliveryDatabase,
  workerId: string,
  batchSize: number,
  claimSeconds = 30,
): Promise<readonly ClaimedOutboxEvent[]> {
  return database.transaction().execute(async (transaction) => {
    const candidates = await transaction
      .selectFrom('outbox_events')
      .selectAll()
      .where('published_at', 'is', null)
      .where('available_at', '<=', sql<Date>`now()`)
      .where((expression) =>
        expression.or([
          expression('claimed_until', 'is', null),
          expression('claimed_until', '<', sql<Date>`now()`),
        ]),
      )
      .orderBy('occurred_at', 'asc')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    if (candidates.length === 0) return [];

    const eventIds = candidates.map((candidate) => candidate.id);
    await transaction
      .updateTable('outbox_events')
      .set({
        claimed_by: workerId,
        claimed_until: sql<Date>`now() + ${`${claimSeconds} seconds`}::interval`,
        publish_attempts: sql<number>`publish_attempts + 1`,
      })
      .where('id', 'in', eventIds)
      .execute();

    return candidates.map((candidate) => ({
      ...(candidate.causation_id === null ? {} : { causationId: candidate.causation_id }),
      correlationId: candidate.correlation_id,
      eventId: candidate.id,
      eventType: candidate.event_type,
      eventVersion: candidate.event_version,
      occurredAt: candidate.occurred_at,
      organizationId: candidate.organization_id,
      payload: candidate.payload,
      projectId: candidate.project_id,
      ...(candidate.traceparent === null ? {} : { traceparent: candidate.traceparent }),
    }));
  });
}

export async function markOutboxPublished(
  database: DeliveryDatabase,
  eventId: string,
  workerId: string,
): Promise<boolean> {
  const result = await database
    .updateTable('outbox_events')
    .set({ claimed_by: null, claimed_until: null, published_at: new Date() })
    .where('id', '=', eventId)
    .where('claimed_by', '=', workerId)
    .where('published_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function startInboxDelivery(
  database: DeliveryDatabase,
  consumerName: string,
  eventId: string,
  workerId: string,
  leaseSeconds = 300,
): Promise<boolean> {
  return database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('consumer_inbox')
      .values({
        claimed_by: null,
        claimed_until: null,
        completed_at: null,
        consumer_name: consumerName,
        event_id: eventId,
        result: null,
      })
      .onConflict((conflict) => conflict.columns(['consumer_name', 'event_id']).doNothing())
      .executeTakeFirst();
    const result = await transaction
      .updateTable('consumer_inbox')
      .set({
        claimed_by: workerId,
        claimed_until: sql<Date>`now() + ${`${leaseSeconds} seconds`}::interval`,
      })
      .where('consumer_name', '=', consumerName)
      .where('event_id', '=', eventId)
      .where('completed_at', 'is', null)
      .where((expression) =>
        expression.or([
          expression('claimed_until', 'is', null),
          expression('claimed_until', '<', sql<Date>`now()`),
          expression('claimed_by', '=', workerId),
        ]),
      )
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  });
}

export async function completeInboxDelivery(
  database: DeliveryDatabase,
  consumerName: string,
  eventId: string,
  workerId: string,
  result: string,
): Promise<void> {
  const update = await database
    .updateTable('consumer_inbox')
    .set({ completed_at: new Date(), result })
    .where('consumer_name', '=', consumerName)
    .where('event_id', '=', eventId)
    .where('claimed_by', '=', workerId)
    .executeTakeFirst();
  if (update.numUpdatedRows !== 1n) throw new Error('INBOX_LEASE_NOT_OWNED');
}

export type TaskLease = Readonly<{
  attemptId: string;
  fencingToken: string;
  taskId: string;
  taskType: string;
}>;

export async function leaseNextTask(
  database: DeliveryDatabase,
  workerId: string,
  leaseSeconds = 60,
): Promise<TaskLease | undefined> {
  return database.transaction().execute(async (transaction) => {
    const task = await transaction
      .selectFrom('tasks')
      .selectAll()
      .where('status', 'in', ['PENDING', 'RETRY_WAIT'])
      .where('available_at', '<=', sql<Date>`now()`)
      .where((expression) => expression('attempt_count', '<', expression.ref('max_attempts')))
      .orderBy('created_at', 'asc')
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (task === undefined) return undefined;

    const attemptNumber = task.attempt_count + 1;
    const fencingToken = BigInt(task.version + 1).toString();
    const attempt = await transaction
      .insertInto('task_attempts')
      .values({
        attempt_number: attemptNumber,
        completed_at: null,
        error_code: null,
        error_detail: null,
        fencing_token: fencingToken,
        heartbeat_at: new Date(),
        lease_expires_at: sql<Date>`now() + ${`${leaseSeconds} seconds`}::interval`,
        organization_id: task.organization_id,
        project_id: task.project_id,
        source_event_id: null,
        status: 'LEASED',
        task_id: task.id,
        worker_id: workerId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('tasks')
      .set({ attempt_count: attemptNumber, status: 'LEASED', version: task.version + 1 })
      .where('id', '=', task.id)
      .where('version', '=', task.version)
      .executeTakeFirstOrThrow();
    return { attemptId: attempt.id, fencingToken, taskId: task.id, taskType: task.task_type };
  });
}

export async function leaseTaskById(
  database: DeliveryDatabase,
  taskId: string,
  workerId: string,
  leaseSeconds = 300,
  sourceEventId?: string,
): Promise<TaskLease | undefined> {
  return database.transaction().execute(async (transaction) => {
    const task = await transaction
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', taskId)
      .where('status', 'in', ['PENDING', 'RETRY_WAIT'])
      .where('available_at', '<=', sql<Date>`now()`)
      .where((expression) => expression('attempt_count', '<', expression.ref('max_attempts')))
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (task === undefined) return undefined;
    const attemptNumber = task.attempt_count + 1;
    const fencingToken = BigInt(task.version + 1).toString();
    const attempt = await transaction
      .insertInto('task_attempts')
      .values({
        attempt_number: attemptNumber,
        completed_at: null,
        error_code: null,
        error_detail: null,
        fencing_token: fencingToken,
        heartbeat_at: new Date(),
        lease_expires_at: sql<Date>`now() + ${`${leaseSeconds} seconds`}::interval`,
        organization_id: task.organization_id,
        project_id: task.project_id,
        source_event_id: sourceEventId ?? null,
        status: 'RUNNING',
        task_id: task.id,
        worker_id: workerId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const updated = await transaction
      .updateTable('tasks')
      .set({ attempt_count: attemptNumber, status: 'LEASED', version: task.version + 1 })
      .where('id', '=', task.id)
      .where('version', '=', task.version)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error('TASK_LEASE_CONFLICT');
    return { attemptId: attempt.id, fencingToken, taskId: task.id, taskType: task.task_type };
  });
}

export async function heartbeatTaskLease(
  database: DeliveryDatabase,
  lease: TaskLease,
  leaseSeconds = 300,
): Promise<boolean> {
  const result = await database
    .updateTable('task_attempts')
    .set({
      heartbeat_at: new Date(),
      lease_expires_at: sql<Date>`now() + ${`${leaseSeconds} seconds`}::interval`,
    })
    .where('id', '=', lease.attemptId)
    .where('fencing_token', '=', lease.fencingToken)
    .where('status', 'in', ['LEASED', 'RUNNING'])
    .where('lease_expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function ownsTaskLease(
  database: DeliveryDatabase | DeliveryTransaction,
  lease: TaskLease,
): Promise<boolean> {
  const owned = await database
    .selectFrom('tasks')
    .innerJoin('task_attempts', 'task_attempts.task_id', 'tasks.id')
    .select('tasks.id')
    .where('tasks.id', '=', lease.taskId)
    .where('tasks.version', '=', Number(lease.fencingToken))
    .where('tasks.status', '=', 'LEASED')
    .where('task_attempts.id', '=', lease.attemptId)
    .where('task_attempts.task_id', '=', lease.taskId)
    .where('task_attempts.fencing_token', '=', lease.fencingToken)
    .where('task_attempts.status', 'in', ['LEASED', 'RUNNING'])
    .where('task_attempts.lease_expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return owned !== undefined;
}

export async function acquireProviderCapacityLease(
  database: DeliveryDatabase,
  input: Readonly<{
    attemptId: string;
    globalLimit: number;
    leaseSeconds: number;
    projectId: string;
    projectLimit: number;
    provider: string;
  }>,
): Promise<number | undefined> {
  if (input.globalLimit < 1 || input.projectLimit < 1 || input.projectLimit > input.globalLimit) {
    throw new Error('INVALID_PROVIDER_CAPACITY_LIMIT');
  }
  return database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${input.provider}:${input.projectId}`}, 0))`.execute(
      transaction,
    );
    await transaction
      .deleteFrom('provider_capacity_leases')
      .where('provider', '=', input.provider)
      .where('lease_expires_at', '<=', sql<Date>`now()`)
      .execute();
    const projectUsage = await transaction
      .selectFrom('provider_capacity_leases')
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .where('provider', '=', input.provider)
      .where('project_id', '=', input.projectId)
      .executeTakeFirstOrThrow();
    if (projectUsage.count >= input.projectLimit) return undefined;
    for (let slot = 0; slot < input.globalLimit; slot += 1) {
      const acquired = await transaction
        .insertInto('provider_capacity_leases')
        .values({
          attempt_id: input.attemptId,
          heartbeat_at: new Date(),
          lease_expires_at: sql<Date>`now() + ${`${input.leaseSeconds} seconds`}::interval`,
          project_id: input.projectId,
          provider: input.provider,
          slot,
        })
        .onConflict((conflict) => conflict.columns(['provider', 'slot']).doNothing())
        .returning('slot')
        .executeTakeFirst();
      if (acquired !== undefined) return acquired.slot;
    }
    return undefined;
  });
}

export async function releaseProviderCapacityLease(
  database: DeliveryDatabase,
  provider: string,
  attemptId: string,
): Promise<void> {
  await database
    .deleteFrom('provider_capacity_leases')
    .where('provider', '=', provider)
    .where('attempt_id', '=', attemptId)
    .execute();
}

export async function failTaskLease(
  database: DeliveryDatabase,
  lease: TaskLease,
  input: Readonly<{
    errorCode: string;
    retryAt?: Date;
    retryEvent?: OutboxEventInput;
  }>,
): Promise<boolean> {
  return database.transaction().execute(async (transaction) => {
    const attemptResult = await transaction
      .updateTable('task_attempts')
      .set({ completed_at: new Date(), error_code: input.errorCode, status: 'FAILED' })
      .where('id', '=', lease.attemptId)
      .where('fencing_token', '=', lease.fencingToken)
      .where('status', 'in', ['LEASED', 'RUNNING'])
      .executeTakeFirst();
    if (attemptResult.numUpdatedRows !== 1n) return false;
    const task = await transaction
      .selectFrom('tasks')
      .select(['attempt_count', 'max_attempts'])
      .where('id', '=', lease.taskId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const retry = input.retryAt !== undefined && task.attempt_count < task.max_attempts;
    const taskResult = await transaction
      .updateTable('tasks')
      .set({
        ...(retry ? { available_at: input.retryAt } : {}),
        status: retry ? 'RETRY_WAIT' : 'FAILED',
        version: sql<number>`version + 1`,
      })
      .where('id', '=', lease.taskId)
      .where('version', '=', Number(lease.fencingToken))
      .where('status', '=', 'LEASED')
      .executeTakeFirst();
    if (taskResult.numUpdatedRows === 1n && retry && input.retryEvent !== undefined) {
      await insertOutboxEvent(transaction, {
        ...input.retryEvent,
        availableAt: input.retryAt,
      });
    }
    return taskResult.numUpdatedRows === 1n;
  });
}

export async function completeTaskLease(
  database: DeliveryDatabase,
  lease: TaskLease,
): Promise<boolean> {
  return database
    .transaction()
    .execute((transaction) => completeTaskLeaseInTransaction(transaction, lease));
}

export async function completeTaskLeaseInTransaction(
  transaction: DeliveryTransaction,
  lease: TaskLease,
): Promise<boolean> {
  const attemptResult = await transaction
    .updateTable('task_attempts')
    .set({ completed_at: new Date(), status: 'SUCCEEDED' })
    .where('id', '=', lease.attemptId)
    .where('task_id', '=', lease.taskId)
    .where('fencing_token', '=', lease.fencingToken)
    .where('status', 'in', ['LEASED', 'RUNNING'])
    .where('lease_expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  if (attemptResult.numUpdatedRows !== 1n) return false;
  const taskResult = await transaction
    .updateTable('tasks')
    .set({ status: 'SUCCEEDED', version: sql<number>`version + 1` })
    .where('id', '=', lease.taskId)
    .where('version', '=', Number(lease.fencingToken))
    .where('status', '=', 'LEASED')
    .executeTakeFirst();
  return taskResult.numUpdatedRows === 1n;
}

export type ReapedTaskLease = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  sourceEventId?: string;
  taskId: string;
  taskType: string;
}>;

/**
 * Atomically fences expired attempts and makes their tasks eligible for another attempt.
 * The caller supplies a fresh command which is persisted in the same transaction.
 */
export async function reapExpiredTaskLeases(
  database: DeliveryDatabase,
  createRecoveryEvent: (task: ReapedTaskLease) => OutboxEventInput,
  batchSize = 50,
): Promise<readonly ReapedTaskLease[]> {
  return database.transaction().execute(async (transaction) => {
    const expired = await transaction
      .selectFrom('tasks')
      .innerJoin('task_attempts', (join) =>
        join
          .onRef('task_attempts.task_id', '=', 'tasks.id')
          .onRef('task_attempts.fencing_token', '=', 'tasks.version'),
      )
      .select([
        'tasks.id as task_id',
        'tasks.organization_id',
        'tasks.project_id',
        'tasks.run_id',
        'tasks.task_type',
        'tasks.attempt_count',
        'tasks.max_attempts',
        'tasks.version',
        'task_attempts.id as attempt_id',
        'task_attempts.source_event_id',
      ])
      .where('tasks.status', '=', 'LEASED')
      .where('task_attempts.status', 'in', ['LEASED', 'RUNNING'])
      .where('task_attempts.lease_expires_at', '<=', sql<Date>`now()`)
      .orderBy('task_attempts.lease_expires_at', 'asc')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();

    const requeued: ReapedTaskLease[] = [];
    for (const item of expired) {
      const canRetry = item.attempt_count < item.max_attempts;
      const attempt = await transaction
        .updateTable('task_attempts')
        .set({ completed_at: new Date(), error_code: 'LEASE_EXPIRED', status: 'LEASE_EXPIRED' })
        .where('id', '=', item.attempt_id)
        .where('fencing_token', '=', String(item.version))
        .where('status', 'in', ['LEASED', 'RUNNING'])
        .executeTakeFirst();
      if (attempt.numUpdatedRows !== 1n) continue;
      const task = await transaction
        .updateTable('tasks')
        .set({
          available_at: sql<Date>`now()`,
          status: canRetry ? 'RETRY_WAIT' : 'FAILED',
          version: sql<number>`version + 1`,
        })
        .where('id', '=', item.task_id)
        .where('version', '=', item.version)
        .where('status', '=', 'LEASED')
        .executeTakeFirst();
      if (task.numUpdatedRows !== 1n || !canRetry) continue;
      const requeuedTask: ReapedTaskLease = {
        organizationId: item.organization_id,
        projectId: item.project_id,
        runId: item.run_id,
        ...(item.source_event_id === null ? {} : { sourceEventId: item.source_event_id }),
        taskId: item.task_id,
        taskType: item.task_type,
      };
      requeued.push(requeuedTask);
      await insertOutboxEvent(transaction, createRecoveryEvent(requeuedTask));
    }
    return requeued;
  });
}
