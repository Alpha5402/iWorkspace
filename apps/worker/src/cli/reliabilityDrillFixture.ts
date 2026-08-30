import { createHash, randomUUID } from 'node:crypto';

import { insertOutboxEvent, type DeliveryDatabase, type TaskLease } from '@delivery/database';

import { type ReliabilityFixture } from './reliabilityDrillContract.js';

export async function seedReliabilityReview(
  database: DeliveryDatabase,
): Promise<ReliabilityFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const rulesetId = randomUUID();
  const versionId = randomUUID();
  const repositoryId = randomUUID();
  const runId = randomUUID();
  const taskId = randomUUID();
  await database
    .insertInto('users')
    .values({ id: userId, email: `${userId}@example.invalid`, status: 'ACTIVE' })
    .execute();
  await database
    .insertInto('organizations')
    .values({ id: organizationId, name: 'Reliability drill' })
    .execute();
  await database
    .insertInto('organization_members')
    .values({ organization_id: organizationId, user_id: userId, role: 'OWNER' })
    .execute();
  await database
    .insertInto('projects')
    .values({
      id: projectId,
      organization_id: organizationId,
      name: 'Drill',
      slug: 'drill',
      default_ruleset_version_id: null,
    })
    .execute();
  await database
    .insertInto('rulesets')
    .values({
      id: rulesetId,
      organization_id: organizationId,
      project_id: projectId,
      name: 'Empty',
      created_by: userId,
    })
    .execute();
  await database
    .insertInto('ruleset_versions')
    .values({
      id: versionId,
      organization_id: organizationId,
      project_id: projectId,
      ruleset_id: rulesetId,
      version: 1,
      status: 'PUBLISHED',
      rules: '[]',
      content_hash: createHash('sha256').update('[]').digest('hex'),
      published_at: new Date(),
      created_by: userId,
    })
    .execute();
  await database
    .insertInto('repository_connections')
    .values({
      id: repositoryId,
      organization_id: organizationId,
      project_id: projectId,
      installation_id: '10',
      repository_id: '20',
      owner_login: 'drill',
      repository_name: 'repo',
      status: 'ACTIVE',
      permissions: {},
    })
    .execute();
  await database
    .insertInto('review_runs')
    .values({
      id: runId,
      organization_id: organizationId,
      project_id: projectId,
      repository_connection_id: repositoryId,
      pull_request_number: 1,
      base_sha: null,
      head_sha: null,
      diff_hash: null,
      ruleset_version_id: versionId,
      model: 'stub',
      prompt_version: 'drill-v1',
      status: 'ACCEPTED',
      coverage_complete: false,
      rerun_of_run_id: null,
      request_idempotency_key: 'reliability-drill',
      version: 0,
      started_at: null,
      completed_at: null,
    })
    .execute();
  await database
    .insertInto('tasks')
    .values({
      id: taskId,
      organization_id: organizationId,
      project_id: projectId,
      run_id: runId,
      task_type: 'ACQUIRE_SOURCE',
      status: 'PENDING',
      available_at: new Date(0),
      attempt_count: 0,
      max_attempts: 3,
      version: 0,
    })
    .execute();
  await database.transaction().execute((transaction) =>
    insertOutboxEvent(transaction, {
      correlationId: runId,
      eventId: randomUUID(),
      eventType: 'review.acquire.requested',
      organizationId,
      payload: { runId, taskId },
      projectId,
    }),
  );
  return { organizationId, projectId, runId, taskId };
}

export async function loadCurrentReliabilityLease(
  database: DeliveryDatabase,
  taskId: string,
): Promise<TaskLease> {
  const row = await database
    .selectFrom('task_attempts')
    .innerJoin('tasks', 'tasks.id', 'task_attempts.task_id')
    .select([
      'task_attempts.id as attemptId',
      'task_attempts.fencing_token as fencingToken',
      'tasks.task_type as taskType',
    ])
    .where('tasks.id', '=', taskId)
    .where('tasks.status', '=', 'LEASED')
    .executeTakeFirstOrThrow();
  return {
    attemptId: row.attemptId,
    fencingToken: row.fencingToken,
    taskId,
    taskType: row.taskType,
  };
}

export async function loadAttemptSourceEventId(
  database: DeliveryDatabase,
  attemptId: string,
): Promise<string> {
  const row = await database
    .selectFrom('task_attempts')
    .select('source_event_id')
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
  if (row.source_event_id === null) throw new Error('SOURCE_EVENT_ID_MISSING');
  return row.source_event_id;
}
