import { randomUUID } from 'node:crypto';

import {
  acquireProviderCapacityLease,
  claimOutboxEvents,
  completeInboxDelivery,
  completeTaskLease,
  failTaskLease,
  heartbeatTaskLease,
  insertOutboxEvent,
  leaseNextTask,
  leaseTaskById,
  markOutboxPublished,
  ownsTaskLease,
  reapExpiredTaskLeases,
  releaseProviderCapacityLease,
  startInboxDelivery,
} from '@delivery/database';
import { describe, expect, it } from 'vitest';

import { createEnvironment, createMemoryDatabase } from './index.js';

describe('test environment factory', () => {
  it('provides safe defaults and explicit overrides', () => {
    expect(createEnvironment({ LOG_LEVEL: 'debug' })).toMatchObject({
      LOG_LEVEL: 'debug',
      NODE_ENV: 'test',
    });
  });

  it('creates an isolated Kysely database with generated canonical emails', async () => {
    const database = await createMemoryDatabase();
    const user = await database
      .insertInto('users')
      .values({ email: ' Owner@Example.com ', status: 'ACTIVE' })
      .returning(['id', 'email_canonical'])
      .executeTakeFirstOrThrow();

    expect(user.email_canonical).toBe('owner@example.com');
    await database.destroy();
  });

  it('persists an outbox delay and enforces inbox ownership', async () => {
    const database = await createMemoryDatabase();
    const fixture = await seedReviewTask(database);
    const availableAt = new Date(Date.now() + 60_000);
    const firstEvent = eventFor(fixture, availableAt);
    await database
      .transaction()
      .execute((transaction) => insertOutboxEvent(transaction, firstEvent));
    const stored = await database
      .selectFrom('outbox_events')
      .select('available_at')
      .where('id', '=', firstEvent.eventId)
      .executeTakeFirstOrThrow();
    expect(new Date(stored.available_at).getTime()).toBe(availableAt.getTime());

    const inboxEventId = randomUUID();
    await expect(startInboxDelivery(database, 'review-v1', inboxEventId, 'worker-a')).resolves.toBe(
      true,
    );
    await expect(startInboxDelivery(database, 'review-v1', inboxEventId, 'worker-b')).resolves.toBe(
      false,
    );
    await expect(
      completeInboxDelivery(database, 'review-v1', inboxEventId, 'worker-b', 'INVALID'),
    ).rejects.toThrow('INBOX_LEASE_NOT_OWNED');
    await expect(
      completeInboxDelivery(database, 'review-v1', inboxEventId, 'worker-a', 'SUCCEEDED'),
    ).resolves.toBeUndefined();

    await database.destroy();
  });

  it('claims outbox work once per lease owner and preserves event lineage', async () => {
    const database = await createMemoryDatabase();
    const fixture = await seedReviewTask(database);
    const event = {
      ...eventFor(fixture),
      causationId: randomUUID(),
      traceparent: '00-test-trace',
    };
    await database.transaction().execute((transaction) => insertOutboxEvent(transaction, event));

    const claimed = await claimOutboxEvents(database, 'relay-a', 10);
    expect(claimed).toEqual([
      expect.objectContaining({
        causationId: event.causationId,
        correlationId: fixture.runId,
        eventId: event.eventId,
        traceparent: event.traceparent,
      }),
    ]);
    await expect(claimOutboxEvents(database, 'relay-b', 10)).resolves.toEqual([]);
    await expect(markOutboxPublished(database, event.eventId, 'relay-b')).resolves.toBe(false);
    await expect(markOutboxPublished(database, event.eventId, 'relay-a')).resolves.toBe(true);
    await expect(claimOutboxEvents(database, 'relay-a', 10)).resolves.toEqual([]);
    await database.destroy();
  });

  it('leases, heartbeats, completes, and fences stale task attempts', async () => {
    const database = await createMemoryDatabase();
    const fixture = await seedReviewTask(database);
    const lease = await leaseNextTask(database, 'worker-a', 60);
    expect(lease).toMatchObject({ taskId: fixture.taskId, taskType: fixture.taskType });
    if (lease === undefined) throw new Error('TEST_LEASE_REQUIRED');

    await expect(ownsTaskLease(database, lease)).resolves.toBe(true);
    await expect(heartbeatTaskLease(database, lease, 60)).resolves.toBe(true);
    await expect(completeTaskLease(database, lease)).resolves.toBe(true);
    await expect(ownsTaskLease(database, lease)).resolves.toBe(false);
    await expect(heartbeatTaskLease(database, lease, 60)).resolves.toBe(false);
    await expect(completeTaskLease(database, lease)).resolves.toBe(false);
    await expect(leaseTaskById(database, fixture.taskId, 'worker-b')).resolves.toBeUndefined();
    await database.destroy();
  });

  it('persists retry timing and causation, then prevents the failed attempt from writing', async () => {
    const database = await createMemoryDatabase();
    const fixture = await seedReviewTask(database);
    const sourceEventId = randomUUID();
    const lease = await leaseTaskById(database, fixture.taskId, 'worker-a', 60, sourceEventId);
    if (lease === undefined) throw new Error('TEST_LEASE_REQUIRED');
    const retryAt = new Date(Date.now() + 30_000);
    const recovery = { ...eventFor(fixture, retryAt), causationId: sourceEventId };

    await expect(
      failTaskLease(database, lease, {
        errorCode: 'BROKER_TEMPORARY',
        retryAt,
        retryEvent: recovery,
      }),
    ).resolves.toBe(true);
    await expect(failTaskLease(database, lease, { errorCode: 'LATE_FAILURE' })).resolves.toBe(
      false,
    );
    const [task, attempt, event] = await Promise.all([
      database
        .selectFrom('tasks')
        .select(['status', 'available_at'])
        .where('id', '=', fixture.taskId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('task_attempts')
        .select(['status', 'source_event_id'])
        .where('id', '=', lease.attemptId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('outbox_events')
        .select(['available_at', 'causation_id'])
        .where('id', '=', recovery.eventId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(task.status).toBe('RETRY_WAIT');
    expect(new Date(task.available_at).getTime()).toBe(retryAt.getTime());
    expect(attempt).toMatchObject({ source_event_id: sourceEventId, status: 'FAILED' });
    expect(event.causation_id).toBe(sourceEventId);
    await database.destroy();
  });

  it('reaps an expired attempt with a fresh command and increments the fencing token', async () => {
    const database = await createMemoryDatabase();
    const fixture = await seedReviewTask(database);
    const originalEvent = randomUUID();
    const staleLease = await leaseTaskById(database, fixture.taskId, 'worker-a', -1, originalEvent);
    if (staleLease === undefined) throw new Error('TEST_LEASE_REQUIRED');

    const reaped = await reapExpiredTaskLeases(database, (task) => ({
      ...(task.sourceEventId === undefined ? {} : { causationId: task.sourceEventId }),
      correlationId: task.runId,
      eventId: randomUUID(),
      eventType: 'review.acquire.requested',
      organizationId: task.organizationId,
      payload: { runId: task.runId, taskId: task.taskId },
      projectId: task.projectId,
    }));
    expect(reaped).toEqual([
      expect.objectContaining({ sourceEventId: originalEvent, taskId: fixture.taskId }),
    ]);
    await expect(ownsTaskLease(database, staleLease)).resolves.toBe(false);
    const replacement = await leaseTaskById(database, fixture.taskId, 'worker-b');
    expect(replacement?.fencingToken).not.toBe(staleLease.fencingToken);
    await database.destroy();
  });

  it('coordinates provider capacity globally and per project and releases owned slots', async () => {
    const database = await createMemoryDatabase();
    const fixture = await seedReviewTask(database);
    const input = {
      globalLimit: 2,
      leaseSeconds: 60,
      projectId: fixture.projectId,
      projectLimit: 1,
      provider: 'deepseek',
    };
    await expect(
      acquireProviderCapacityLease(database, { ...input, globalLimit: 0, attemptId: randomUUID() }),
    ).rejects.toThrow('INVALID_PROVIDER_CAPACITY_LIMIT');
    const firstAttempt = randomUUID();
    await expect(
      acquireProviderCapacityLease(database, { ...input, attemptId: firstAttempt }),
    ).resolves.toBe(0);
    await expect(
      acquireProviderCapacityLease(database, { ...input, attemptId: randomUUID() }),
    ).resolves.toBeUndefined();
    await releaseProviderCapacityLease(database, 'deepseek', firstAttempt);
    await expect(
      acquireProviderCapacityLease(database, { ...input, attemptId: randomUUID() }),
    ).resolves.toBe(0);
    await database.destroy();
  });
});

type ReviewTaskFixture = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  taskId: string;
  taskType: string;
}>;

function eventFor(
  fixture: ReviewTaskFixture,
  availableAt?: Date,
): Readonly<{
  availableAt?: Date;
  correlationId: string;
  eventId: string;
  eventType: string;
  organizationId: string;
  payload: Record<string, unknown>;
  projectId: string;
}> {
  return {
    ...(availableAt === undefined ? {} : { availableAt }),
    correlationId: fixture.runId,
    eventId: randomUUID(),
    eventType: 'review.acquire.requested',
    organizationId: fixture.organizationId,
    payload: { runId: fixture.runId, taskId: fixture.taskId },
    projectId: fixture.projectId,
  };
}

async function seedReviewTask(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
): Promise<ReviewTaskFixture> {
  const user = await database
    .insertInto('users')
    .values({ email: `${randomUUID()}@example.com`, status: 'ACTIVE' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const organization = await database
    .insertInto('organizations')
    .values({ name: 'Test' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const project = await database
    .insertInto('projects')
    .values({
      default_ruleset_version_id: null,
      name: 'Project',
      organization_id: organization.id,
      slug: randomUUID(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const ruleset = await database
    .insertInto('rulesets')
    .values({
      created_by: user.id,
      name: 'Rules',
      organization_id: organization.id,
      project_id: project.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const version = await database
    .insertInto('ruleset_versions')
    .values({
      content_hash: 'hash',
      created_by: user.id,
      organization_id: organization.id,
      project_id: project.id,
      published_at: new Date(),
      rules: '[]',
      ruleset_id: ruleset.id,
      status: 'PUBLISHED',
      version: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const repository = await database
    .insertInto('repository_connections')
    .values({
      installation_id: '1',
      organization_id: organization.id,
      owner_login: 'owner',
      permissions: {},
      project_id: project.id,
      repository_id: '1',
      repository_name: 'repo',
      status: 'ACTIVE',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const runId = randomUUID();
  await database
    .insertInto('review_runs')
    .values({
      base_sha: null,
      completed_at: null,
      coverage_complete: false,
      diff_hash: null,
      head_sha: null,
      id: runId,
      model: 'stub',
      organization_id: organization.id,
      project_id: project.id,
      prompt_version: 'v1',
      pull_request_number: 1,
      repository_connection_id: repository.id,
      request_idempotency_key: null,
      rerun_of_run_id: null,
      ruleset_version_id: version.id,
      started_at: null,
      status: 'ACCEPTED',
      version: 0,
    })
    .execute();
  const task = await database
    .insertInto('tasks')
    .values({
      attempt_count: 0,
      available_at: new Date(0),
      max_attempts: 3,
      organization_id: organization.id,
      project_id: project.id,
      run_id: runId,
      status: 'PENDING',
      task_type: 'ACQUIRE_SOURCE',
      version: 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    organizationId: organization.id,
    projectId: project.id,
    runId,
    taskId: task.id,
    taskType: 'ACQUIRE_SOURCE',
  };
}
