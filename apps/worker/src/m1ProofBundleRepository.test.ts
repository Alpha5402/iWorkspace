import { randomUUID } from 'node:crypto';

import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresM1ProofBundleRepository } from './m1ProofBundleRepository.js';

describe('PostgreSQL M1 proof bundle repository', () => {
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;

  beforeEach(async () => {
    database = await createMemoryDatabase();
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('loads frozen run and ruleset identity while keeping absent evidence explicit', async () => {
    const ids = {
      organization: randomUUID(),
      parentArtifact: randomUUID(),
      project: randomUUID(),
      providerInvocation: randomUUID(),
      repository: randomUUID(),
      ruleset: randomUUID(),
      rulesetVersion: randomUUID(),
      run: randomUUID(),
      childArtifact: randomUUID(),
      task: randomUUID(),
      attempt: randomUUID(),
      batch: randomUUID(),
      effect: randomUUID(),
      finding: randomUUID(),
      verification: randomUUID(),
      evidence: randomUUID(),
      user: randomUUID(),
    };
    await database
      .insertInto('users')
      .values({ email: `${ids.user}@example.com`, id: ids.user })
      .execute();
    await database
      .insertInto('organizations')
      .values({ id: ids.organization, name: 'Proof Organization' })
      .execute();
    await database
      .insertInto('projects')
      .values({
        default_ruleset_version_id: null,
        id: ids.project,
        name: 'Proof Project',
        organization_id: ids.organization,
        slug: 'proof-project',
      })
      .execute();
    await seedReviewRun(database, ids);
    await database
      .insertInto('artifacts')
      .values([
        {
          artifact_type: 'SOURCE_DIFF',
          content_hash: 'a'.repeat(64),
          id: ids.parentArtifact,
          media_type: 'text/x-diff',
          object_key: 'artifacts/source',
          organization_id: ids.organization,
          project_id: ids.project,
          retention_until: new Date('2026-12-01T00:00:00.000Z'),
          run_id: ids.run,
          size_bytes: '12',
        },
        {
          artifact_type: 'summary.txt',
          content_hash: 'b'.repeat(64),
          id: ids.childArtifact,
          media_type: 'text/plain',
          object_key: 'artifacts/summary',
          organization_id: ids.organization,
          project_id: ids.project,
          retention_until: new Date('2026-12-01T00:00:00.000Z'),
          run_id: ids.run,
          size_bytes: '24',
        },
      ])
      .execute();
    await database
      .insertInto('artifact_links')
      .values({
        child_artifact_id: ids.childArtifact,
        organization_id: ids.organization,
        parent_artifact_id: ids.parentArtifact,
        project_id: ids.project,
        relation: 'DERIVED_FROM',
      })
      .execute();
    await database
      .insertInto('evidence_records')
      .values({
        artifact_id: ids.parentArtifact,
        evidence_type: 'FROZEN_PR_DIFF',
        id: ids.evidence,
        metadata: { baseSha: 'base', headSha: 'head' },
        organization_id: ids.organization,
        project_id: ids.project,
        run_id: ids.run,
        source_hash: 'diff',
      })
      .execute();
    await database
      .insertInto('tasks')
      .values({
        attempt_count: 1,
        available_at: new Date('2026-08-30T01:00:00.000Z'),
        id: ids.task,
        max_attempts: 3,
        organization_id: ids.organization,
        project_id: ids.project,
        run_id: ids.run,
        status: 'SUCCEEDED',
        task_type: 'ACQUIRE_SOURCE',
        version: 2,
      })
      .execute();
    await database
      .insertInto('task_attempts')
      .values({
        attempt_number: 1,
        completed_at: new Date('2026-08-30T01:01:00.000Z'),
        error_code: null,
        error_detail: null,
        fencing_token: '2',
        heartbeat_at: new Date('2026-08-30T01:00:30.000Z'),
        id: ids.attempt,
        lease_expires_at: new Date('2026-08-30T01:02:00.000Z'),
        organization_id: ids.organization,
        project_id: ids.project,
        source_event_id: null,
        status: 'SUCCEEDED',
        task_id: ids.task,
        worker_id: 'worker-host:1234',
      })
      .execute();
    await database
      .insertInto('provider_invocations')
      .values({
        completed_at: new Date('2026-08-30T01:02:00.000Z'),
        error_code: null,
        id: ids.providerInvocation,
        input_hash: 'input-hash',
        input_tokens: 100,
        latency_ms: 250,
        model: 'deepseek-v4-flash',
        organization_id: ids.organization,
        output_tokens: 25,
        project_id: ids.project,
        prompt_version: 'review-v1',
        provider: 'DEEPSEEK',
        provider_response_id: 'response-1',
        run_id: ids.run,
        schema_version: 'finding-v1',
        status: 'SUCCEEDED',
      })
      .execute();
    await database
      .insertInto('review_batches')
      .values({
        category: 'DEFECT',
        estimated_tokens: 100,
        id: ids.batch,
        input_hash: 'batch-input',
        organization_id: ids.organization,
        project_id: ids.project,
        provider_invocation_id: ids.providerInvocation,
        run_id: ids.run,
        sequence: 0,
        status: 'SUCCEEDED',
      })
      .execute();
    await database
      .insertInto('review_findings')
      .values({
        batch_id: ids.batch,
        category: 'DEFECT',
        confidence: 0.95,
        description: 'A race is possible.',
        end_line: 10,
        evidence: JSON.stringify(['changed line']),
        fingerprint: 'finding-fingerprint',
        id: ids.finding,
        organization_id: ids.organization,
        path: 'src/service.ts',
        project_id: ids.project,
        rule_id: 'reliability/race',
        run_id: ids.run,
        severity: 'BLOCKING',
        side: 'RIGHT',
        source: 'MODEL',
        start_line: 10,
        title: 'Race condition',
        verification_status: 'CONFIRMED',
      })
      .execute();
    await database
      .insertInto('finding_verifications')
      .values({
        finding_id: ids.finding,
        id: ids.verification,
        method: 'MODEL',
        provider_invocation_id: ids.providerInvocation,
        rationale: 'Evidence confirms the race.',
        result: 'CONFIRMED',
      })
      .execute();
    await database
      .insertInto('external_effects')
      .values({
        attempt_count: 1,
        effect_type: 'GITHUB_CHECK',
        id: ids.effect,
        last_error_code: null,
        logical_key: `review:${ids.run}`,
        organization_id: ids.organization,
        project_id: ids.project,
        provider: 'GITHUB',
        provider_object_id: 'check-1',
        request_hash: 'request-hash',
        run_id: ids.run,
        status: 'SUCCEEDED',
        updated_at: new Date('2026-08-30T01:03:00.000Z'),
      })
      .execute();
    await database
      .insertInto('run_events')
      .values({
        event_type: 'review.completed',
        organization_id: ids.organization,
        payload: { status: 'SUCCEEDED' },
        project_id: ids.project,
        run_id: ids.run,
      })
      .execute();
    const snapshot = await createPostgresM1ProofBundleRepository(database).load(
      ids.organization,
      ids.run,
    );

    expect(snapshot.run).toMatchObject({
      id: ids.run,
      repository: { id: '456', name: 'iWorkspace', owner: 'Alpha5402' },
      ruleset: {
        contentHash: 'rules-hash',
        id: ids.rulesetVersion,
        status: 'PUBLISHED',
        version: 1,
      },
      status: 'ACCEPTED',
    });
    expect(snapshot.artifacts).toHaveLength(2);
    expect(snapshot.evidence).toMatchObject({
      links: [
        {
          childArtifactId: ids.childArtifact,
          parentArtifactId: ids.parentArtifact,
          relation: 'DERIVED_FROM',
        },
      ],
      records: [{ artifactId: ids.parentArtifact, evidenceType: 'FROZEN_PR_DIFF' }],
    });
    expect(snapshot.execution.tasks).toHaveLength(1);
    expect(snapshot.execution.attempts[0]?.metadata).toMatchObject({
      completedAt: '2026-08-30T01:01:00.000Z',
      fencingToken: '2',
      taskId: ids.task,
    });
    expect(snapshot.execution.attempts[0]?.metadata).not.toHaveProperty('workerId');
    expect(snapshot.execution.attempts[0]?.metadata.workerIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.execution.batches).toHaveLength(1);
    expect(snapshot.execution.providerInvocations).toHaveLength(1);
    expect(snapshot.execution.findings).toHaveLength(1);
    expect(snapshot.execution.findingVerifications).toHaveLength(1);
    expect(snapshot.execution.externalEffects).toHaveLength(1);
    expect(snapshot.execution.runEvents).toHaveLength(1);
  });
});

async function seedReviewRun(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  ids: Readonly<{
    organization: string;
    project: string;
    repository: string;
    ruleset: string;
    rulesetVersion: string;
    run: string;
    user: string;
  }>,
): Promise<void> {
  await database
    .insertInto('rulesets')
    .values({
      created_by: ids.user,
      id: ids.ruleset,
      name: 'M1 Rules',
      organization_id: ids.organization,
      project_id: ids.project,
    })
    .execute();
  await database
    .insertInto('ruleset_versions')
    .values({
      content_hash: 'rules-hash',
      created_by: ids.user,
      id: ids.rulesetVersion,
      organization_id: ids.organization,
      project_id: ids.project,
      published_at: new Date('2026-08-30T01:00:00.000Z'),
      rules: '[]',
      ruleset_id: ids.ruleset,
      status: 'PUBLISHED',
      version: 1,
    })
    .execute();
  await database
    .insertInto('repository_connections')
    .values({
      id: ids.repository,
      installation_id: '123',
      organization_id: ids.organization,
      owner_login: 'Alpha5402',
      permissions: { checks: 'write', contents: 'read' },
      project_id: ids.project,
      repository_id: '456',
      repository_name: 'iWorkspace',
      status: 'ACTIVE',
    })
    .execute();
  await database
    .insertInto('review_runs')
    .values({
      base_sha: 'base',
      completed_at: null,
      coverage_complete: false,
      diff_hash: 'diff',
      head_sha: 'head',
      id: ids.run,
      model: 'deepseek-v4-flash',
      organization_id: ids.organization,
      project_id: ids.project,
      prompt_version: 'review-v1',
      pull_request_number: 42,
      repository_connection_id: ids.repository,
      request_idempotency_key: null,
      rerun_of_run_id: null,
      ruleset_version_id: ids.rulesetVersion,
      started_at: null,
      status: 'ACCEPTED',
      version: 0,
    })
    .execute();
}
