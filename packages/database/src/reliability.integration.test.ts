import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireProviderCapacityLease,
  completeTaskLease,
  createDatabase,
  failTaskLease,
  leaseTaskById,
  ownsTaskLease,
  reapExpiredTaskLeases,
  releaseProviderCapacityLease,
  type DeliveryDatabase,
} from './index.js';

const describeInfrastructure =
  process.env.RUN_INFRA_INTEGRATION === 'true' ? describe : describe.skip;

describeInfrastructure('PostgreSQL job reliability and tenant isolation', () => {
  let database: DeliveryDatabase;
  const userId = randomUUID();
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const runId = randomUUID();
  const rulesetId = randomUUID();
  const taskId = randomUUID();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
    database = createDatabase(databaseUrl);
    await seedTenant(organizationId, projectId, 'visible');
    await seedTenant(otherOrganizationId, otherProjectId, 'hidden');
    const rulesetVersionId = randomUUID();
    const repositoryId = randomUUID();
    await database
      .insertInto('rulesets')
      .values({
        created_by: userId,
        id: rulesetId,
        name: 'Rules',
        organization_id: organizationId,
        project_id: projectId,
      })
      .execute();
    await database
      .insertInto('ruleset_versions')
      .values({
        content_hash: 'integration-hash',
        created_by: userId,
        id: rulesetVersionId,
        organization_id: organizationId,
        project_id: projectId,
        published_at: new Date(),
        rules: '[]',
        ruleset_id: rulesetId,
        status: 'PUBLISHED',
        version: 1,
      })
      .execute();
    await database
      .insertInto('repository_connections')
      .values({
        id: repositoryId,
        installation_id: '100',
        organization_id: organizationId,
        owner_login: 'integration',
        permissions: {},
        project_id: projectId,
        repository_id: String(Date.now()),
        repository_name: 'repo',
        status: 'ACTIVE',
      })
      .execute();
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
        organization_id: organizationId,
        project_id: projectId,
        prompt_version: 'v1',
        pull_request_number: 1,
        repository_connection_id: repositoryId,
        request_idempotency_key: null,
        rerun_of_run_id: null,
        ruleset_version_id: rulesetVersionId,
        started_at: null,
        status: 'ACCEPTED',
        version: 0,
      })
      .execute();
    await database
      .insertInto('tasks')
      .values({
        attempt_count: 0,
        available_at: new Date(0),
        id: taskId,
        max_attempts: 3,
        organization_id: organizationId,
        project_id: projectId,
        run_id: runId,
        status: 'PENDING',
        task_type: 'ACQUIRE_SOURCE',
        version: 0,
      })
      .execute();
  });

  afterAll(async () => {
    await database
      .deleteFrom('outbox_events')
      .where('organization_id', 'in', [organizationId, otherOrganizationId])
      .execute();
    await database
      .deleteFrom('organizations')
      .where('id', 'in', [organizationId, otherOrganizationId])
      .execute();
    await database.deleteFrom('users').where('id', '=', userId).execute();
    await database.destroy();
  });

  it('persists retry timing, rejects stale completion, and recovers an expired lease atomically', async () => {
    const firstLease = await leaseTaskById(database, taskId, 'worker-a', 60);
    if (firstLease === undefined) throw new Error('FIRST_TASK_LEASE_REQUIRED');
    await expect(ownsTaskLease(database, firstLease)).resolves.toBe(true);
    await expect(
      acquireProviderCapacityLease(database, {
        attemptId: firstLease.attemptId,
        globalLimit: 4,
        leaseSeconds: 210,
        projectId,
        projectLimit: 2,
        provider: 'deepseek',
      }),
    ).resolves.toBe(0);
    await releaseProviderCapacityLease(database, 'deepseek', firstLease.attemptId);
    const retryAt = new Date(Date.now() + 30_000);
    const retryEventId = randomUUID();
    await expect(
      failTaskLease(database, firstLease, {
        errorCode: 'TEMPORARY_FAILURE',
        retryAt,
        retryEvent: {
          correlationId: runId,
          eventId: retryEventId,
          eventType: 'review.acquire.requested',
          organizationId,
          payload: { runId, taskId },
          projectId,
        },
      }),
    ).resolves.toBe(true);
    const retryEvent = await database
      .selectFrom('outbox_events')
      .select('available_at')
      .where('id', '=', retryEventId)
      .executeTakeFirstOrThrow();
    expect(new Date(retryEvent.available_at).getTime()).toBe(retryAt.getTime());
    await expect(completeTaskLease(database, firstLease)).resolves.toBe(false);

    await database
      .updateTable('tasks')
      .set({ available_at: new Date(0) })
      .where('id', '=', taskId)
      .execute();
    const crashedLease = await leaseTaskById(database, taskId, 'worker-crashed', 60);
    if (crashedLease === undefined) throw new Error('CRASHED_TASK_LEASE_REQUIRED');
    await database
      .updateTable('task_attempts')
      .set({ lease_expires_at: new Date(0) })
      .where('id', '=', crashedLease.attemptId)
      .execute();
    const recovered = await reapExpiredTaskLeases(database, (task) => ({
      causationId: retryEventId,
      correlationId: task.runId,
      eventId: randomUUID(),
      eventType: 'review.acquire.requested',
      organizationId: task.organizationId,
      payload: { runId: task.runId, taskId: task.taskId },
      projectId: task.projectId,
    }));

    expect(recovered).toHaveLength(1);
    await expect(completeTaskLease(database, crashedLease)).resolves.toBe(false);
    const state = await database
      .selectFrom('tasks')
      .select(['status', 'version'])
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow();
    expect(state).toMatchObject({ status: 'RETRY_WAIT', version: 4 });
    await expect(
      database
        .selectFrom('outbox_events')
        .select('id')
        .where('correlation_id', '=', runId)
        .execute(),
    ).resolves.toHaveLength(2);
  });

  it('makes the API role see only the transaction tenant through RLS', async () => {
    const visible = await database.transaction().execute(async (transaction) => {
      await sql`set local role iw_api`.execute(transaction);
      await sql`select set_config('app.organization_id', ${organizationId}, true)`.execute(
        transaction,
      );
      return transaction.selectFrom('projects').select(['id', 'slug']).orderBy('slug').execute();
    });

    expect(visible).toEqual([{ id: projectId, slug: 'visible' }]);
  });

  it('allows only one draft per ruleset while preserving published history', async () => {
    const draft = (
      id: string,
      version: number,
    ): Readonly<{
      content_hash: string;
      created_by: string;
      id: string;
      organization_id: string;
      project_id: string;
      published_at: null;
      rules: string;
      ruleset_id: string;
      status: 'DRAFT';
      version: number;
    }> => ({
      content_hash: `draft-${version}`,
      created_by: userId,
      id,
      organization_id: organizationId,
      project_id: projectId,
      published_at: null,
      rules: '[]',
      ruleset_id: rulesetId,
      status: 'DRAFT' as const,
      version,
    });
    const secondVersionId = randomUUID();
    await database.insertInto('ruleset_versions').values(draft(secondVersionId, 2)).execute();
    await expect(
      database.insertInto('ruleset_versions').values(draft(randomUUID(), 3)).execute(),
    ).rejects.toMatchObject({ code: '23505' });

    await database
      .updateTable('ruleset_versions')
      .set({ published_at: new Date(), status: 'PUBLISHED' })
      .where('id', '=', secondVersionId)
      .executeTakeFirstOrThrow();
    await expect(
      database.insertInto('ruleset_versions').values(draft(randomUUID(), 3)).execute(),
    ).resolves.toBeDefined();
  });

  async function seedTenant(
    tenantId: string,
    tenantProjectId: string,
    slug: string,
  ): Promise<void> {
    await database
      .insertInto('users')
      .values({ email: `${userId}@example.com`, id: userId, status: 'ACTIVE' })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    await database.insertInto('organizations').values({ id: tenantId, name: slug }).execute();
    await database
      .insertInto('organization_members')
      .values({ organization_id: tenantId, role: 'OWNER', user_id: userId })
      .execute();
    await database
      .insertInto('projects')
      .values({
        default_ruleset_version_id: null,
        id: tenantProjectId,
        name: slug,
        organization_id: tenantId,
        slug,
      })
      .execute();
  }
});
