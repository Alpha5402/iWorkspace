import { createHash, randomUUID } from 'node:crypto';

import { insertOutboxEvent, type DeliveryDatabase } from '@delivery/database';

import { type CapacitySeed } from './reviewCapacityBenchmarkContract.js';

const categories = ['DESIGN', 'IMPLEMENTATION', 'DEFECT'] as const;

export async function seedCapacityBenchmark(
  database: DeliveryDatabase,
  runCount: number,
  projectCount: number,
): Promise<CapacitySeed> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectIds: string[] = [];
  const repositoryIds: string[] = [];
  const rulesetVersionIds: string[] = [];
  const runIds: string[] = [];

  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('users')
      .values({ email: `${userId}@example.invalid`, id: userId, status: 'ACTIVE' })
      .execute();
    await transaction
      .insertInto('organizations')
      .values({ id: organizationId, name: 'Review capacity benchmark' })
      .execute();
    await transaction
      .insertInto('organization_members')
      .values({ organization_id: organizationId, role: 'OWNER', user_id: userId })
      .execute();

    for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
      const projectId = randomUUID();
      const repositoryId = randomUUID();
      const rulesetId = randomUUID();
      const rulesetVersionId = randomUUID();
      const rules = categories.map((category) => ({
        appliesTo: { languages: ['typescript'], paths: ['src/**'] },
        category,
        defaultSeverity: 'MINOR' as const,
        evidenceRequirement: 'A finding must cite an added line.',
        guidance: `Review ${category.toLocaleLowerCase()} risks in the supplied diff.`,
        id: `${category.toLocaleLowerCase()}/capacity`,
        title: `${category} capacity rule`,
      }));
      await transaction
        .insertInto('projects')
        .values({
          default_ruleset_version_id: null,
          id: projectId,
          name: `Capacity ${projectIndex + 1}`,
          organization_id: organizationId,
          slug: `capacity-${projectIndex + 1}`,
        })
        .execute();
      await transaction
        .insertInto('rulesets')
        .values({
          created_by: userId,
          id: rulesetId,
          name: 'Capacity rules',
          organization_id: organizationId,
          project_id: projectId,
        })
        .execute();
      await transaction
        .insertInto('ruleset_versions')
        .values({
          content_hash: createHash('sha256').update(JSON.stringify(rules)).digest('hex'),
          created_by: userId,
          id: rulesetVersionId,
          organization_id: organizationId,
          project_id: projectId,
          published_at: new Date(),
          rules: JSON.stringify(rules),
          ruleset_id: rulesetId,
          status: 'PUBLISHED',
          version: 1,
        })
        .execute();
      await transaction
        .updateTable('projects')
        .set({ default_ruleset_version_id: rulesetVersionId })
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('repository_connections')
        .values({
          id: repositoryId,
          installation_id: String(projectIndex + 1),
          organization_id: organizationId,
          owner_login: 'capacity',
          permissions: {},
          project_id: projectId,
          repository_id: String(projectIndex + 1),
          repository_name: `repository-${projectIndex + 1}`,
          status: 'ACTIVE',
        })
        .execute();
      projectIds.push(projectId);
      repositoryIds.push(repositoryId);
      rulesetVersionIds.push(rulesetVersionId);
    }

    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const projectIndex = runIndex % projectCount;
      const projectId = projectIds[projectIndex];
      const repositoryId = repositoryIds[projectIndex];
      const rulesetVersionId = rulesetVersionIds[projectIndex];
      if (projectId === undefined || repositoryId === undefined || rulesetVersionId === undefined) {
        throw new Error('CAPACITY_PROJECT_FIXTURE_MISSING');
      }
      const runId = randomUUID();
      const taskId = randomUUID();
      await transaction
        .insertInto('review_runs')
        .values({
          base_sha: null,
          completed_at: null,
          coverage_complete: false,
          diff_hash: null,
          head_sha: null,
          id: runId,
          model: 'capacity-stub',
          organization_id: organizationId,
          project_id: projectId,
          prompt_version: 'capacity-v1',
          pull_request_number: Math.floor(runIndex / projectCount) + 1,
          repository_connection_id: repositoryId,
          request_idempotency_key: `capacity-${runIndex}`,
          rerun_of_run_id: null,
          ruleset_version_id: rulesetVersionId,
          started_at: null,
          status: 'ACCEPTED',
          version: 0,
        })
        .execute();
      await transaction
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
      await insertOutboxEvent(transaction, {
        correlationId: runId,
        eventId: randomUUID(),
        eventType: 'review.acquire.requested',
        organizationId,
        payload: { runId, taskId },
        projectId,
      });
      runIds.push(runId);
    }
  });

  return { organizationId, projectIds, runIds };
}
