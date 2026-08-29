import { createHash, randomUUID } from 'node:crypto';

import { insertOutboxEvent, type ClaimedOutboxEvent } from '@delivery/database';
import { reviewQueues } from '@delivery/messaging';
import { ModelProviderError, type ReviewModelProvider } from '@delivery/providers-agent';
import { GitHubProviderError, type GitHubAppProvider } from '@delivery/providers-github';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewWorker } from './reviewWorker.js';

vi.mock('@delivery/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delivery/database')>()),
  acquireProviderCapacityLease: vi.fn().mockResolvedValue(0),
  releaseProviderCapacityLease: vi.fn().mockResolvedValue(undefined),
}));

class MemoryArtifactStore {
  public readonly objects = new Map<string, Buffer>();
  public close(): void {}
  public get(key: string): Promise<Buffer> {
    const body = this.objects.get(key);
    if (body === undefined) throw new Error('OBJECT_NOT_FOUND');
    return Promise.resolve(body);
  }
  public async put(
    input: Readonly<{
      beforeCommit?: () => Promise<void>;
      body: Buffer;
      mediaType: string;
      organizationId: string;
      projectId: string;
      runId: string;
    }>,
  ): Promise<Readonly<{ contentHash: string; objectKey: string; sizeBytes: number }>> {
    await input.beforeCommit?.();
    const contentHash = createHash('sha256').update(input.body).digest('hex');
    const objectKey = `memory/${input.runId}/${contentHash}`;
    this.objects.set(objectKey, input.body);
    return { contentHash, objectKey, sizeBytes: input.body.byteLength };
  }
}

class ImmediateMessageBus {
  private readonly handlers = new Map<string, (message: never) => Promise<void>>();
  public close(): Promise<void> {
    return Promise.resolve();
  }
  public consume(queue: string, handler: (message: never) => Promise<void>): Promise<void> {
    this.handlers.set(queue, handler);
    return Promise.resolve();
  }
  public async publish(event: ClaimedOutboxEvent): Promise<void> {
    const queue = Object.entries(reviewQueues).find(
      ([name]) => event.eventType === `review.${name}.requested`,
    )?.[1];
    const handler = queue === undefined ? undefined : this.handlers.get(queue);
    if (handler === undefined) throw new Error(`NO_HANDLER:${event.eventType}`);
    await handler({
      content: Buffer.from(
        JSON.stringify({
          ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
          correlationId: event.correlationId,
          eventId: event.eventId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          occurredAt: event.occurredAt.toISOString(),
          organizationId: event.organizationId,
          payload: event.payload,
          projectId: event.projectId,
          ...(event.traceparent === undefined ? {} : { traceparent: event.traceparent }),
        }),
      ),
    } as never);
  }
}

describe('ReviewWorker end-to-end workflow', () => {
  const databases: Awaited<ReturnType<typeof createMemoryDatabase>>[] = [];
  const workers: ReviewWorker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    await Promise.all(databases.splice(0).map((database) => database.destroy()));
  });

  it('freezes source, reviews, verifies, renders lineage, and publishes one blocking Check', async () => {
    const database = await createMemoryDatabase();
    databases.push(database);
    const fixture = await seedAcceptedReview(database);
    const artifacts = new MemoryArtifactStore();
    const bus = new ImmediateMessageBus();
    const createCheckRun = vi.fn().mockResolvedValue('check-42');
    const github = {
      createCheckRun,
      createInstallationToken: vi
        .fn()
        .mockResolvedValue({ expiresAt: 'later', permissions: {}, token: 'installation' }),
      findCheckRunByExternalId: vi.fn().mockResolvedValue(undefined),
      getPullRequestHead: vi.fn().mockResolvedValue(fixture.headSha),
      getPullRequestSnapshot: vi.fn().mockResolvedValue({
        baseSha: fixture.baseSha,
        diff: fixture.diff,
        headSha: fixture.headSha,
      }),
    };
    const reviewBatch = vi.fn<ReviewModelProvider['reviewBatch']>().mockImplementation((request) =>
      Promise.resolve({
        inputHash: createHash('sha256').update(request.diff).digest('hex'),
        latencyMs: 5,
        output: {
          findings: [
            {
              confidence: 0.95,
              description: 'The added value exposes a credential.',
              endLine: 1,
              evidence: ['Added line 1 contains a credential marker.'],
              path: 'src/config.ts',
              ruleId: 'security/model-secret',
              severity: 'BLOCKING',
              startLine: 1,
              title: 'Credential exposure',
            },
          ],
          summary: request.promptVersion.endsWith('-verify') ? 'Confirmed.' : 'One issue.',
        },
        providerResponseId: randomUUID(),
        usage: { inputTokens: 20, outputTokens: 8 },
      }),
    );
    const workerErrors: Record<string, unknown>[] = [];
    const worker = new ReviewWorker(
      database,
      bus,
      github,
      { reviewBatch },
      artifacts,
      'https://app.example.test',
      'worker-test',
      {
        error: vi.fn<(attributes: Record<string, unknown>, message: string) => void>(
          (attributes) => {
            workerErrors.push(attributes);
          },
        ),
        info: vi.fn(),
      },
    );
    workers.push(worker);

    await worker.start();
    await waitFor(
      async () =>
        (
          await database
            .selectFrom('review_runs')
            .select('status')
            .where('id', '=', fixture.runId)
            .executeTakeFirstOrThrow()
        ).status === 'SUCCEEDED',
      async () => ({
        snapshot: await workflowSnapshot(database, fixture.runId),
        workerErrors,
      }),
    );

    const findings = await database
      .selectFrom('review_findings')
      .select(['rule_id', 'verification_status', 'evidence'])
      .where('run_id', '=', fixture.runId)
      .orderBy('rule_id')
      .execute();
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.verification_status === 'CONFIRMED')).toBe(true);
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
    await expect(database.selectFrom('task_attempts').select('status').execute()).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ status: 'SUCCEEDED' })),
    );
    await expect(
      database.selectFrom('provider_invocations').select('status').execute(),
    ).resolves.toHaveLength(2);
    await expect(
      database.selectFrom('finding_verifications').select('id').execute(),
    ).resolves.toHaveLength(2);
    await expect(
      database.selectFrom('artifacts').select('artifact_type').execute(),
    ).resolves.toHaveLength(7);
    await expect(
      database.selectFrom('artifact_links').select('relation').execute(),
    ).resolves.toHaveLength(6);
    await expect(
      database
        .selectFrom('external_effects')
        .select(['status', 'provider_object_id'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      provider_object_id: 'check-42',
      status: 'SUCCEEDED',
    });
    expect(createCheckRun).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    expect(reviewBatch).toHaveBeenCalledTimes(2);
  });

  it('marks a completed analysis stale when the pull request head moves before publication', async () => {
    const database = await createMemoryDatabase();
    databases.push(database);
    const fixture = await seedAcceptedReview(database);
    const artifacts = new MemoryArtifactStore();
    const bus = new ImmediateMessageBus();
    const createCheckRun = vi.fn();
    const worker = new ReviewWorker(
      database,
      bus,
      {
        createCheckRun,
        createInstallationToken: vi
          .fn()
          .mockResolvedValue({ expiresAt: 'later', permissions: {}, token: 'installation' }),
        findCheckRunByExternalId: vi.fn(),
        getPullRequestHead: vi.fn().mockResolvedValue('c'.repeat(40)),
        getPullRequestSnapshot: vi.fn().mockResolvedValue({
          baseSha: fixture.baseSha,
          diff: fixture.diff,
          headSha: fixture.headSha,
        }),
      },
      { reviewBatch: successfulEmptyReview },
      artifacts,
      'https://app.example.test',
      'worker-stale',
      { error: vi.fn(), info: vi.fn() },
    );
    workers.push(worker);
    await worker.start();
    await waitFor(
      async () =>
        (
          await database
            .selectFrom('review_runs')
            .select('status')
            .where('id', '=', fixture.runId)
            .executeTakeFirstOrThrow()
        ).status === 'STALE',
      () => workflowSnapshot(database, fixture.runId),
    );
    expect(createCheckRun).not.toHaveBeenCalled();
    await expect(
      database
        .selectFrom('run_events')
        .select('event_type')
        .where('run_id', '=', fixture.runId)
        .orderBy('id')
        .execute(),
    ).resolves.toContainEqual({ event_type: 'review.stale' });
  });

  it('fails deterministically after one invalid-output repair attempt', async () => {
    const database = await createMemoryDatabase();
    databases.push(database);
    const fixture = await seedAcceptedReview(database);
    const reviewBatch = vi
      .fn<ReviewModelProvider['reviewBatch']>()
      .mockRejectedValue(new ModelProviderError('INVALID_RESPONSE', 'findings must be an array'));
    const worker = new ReviewWorker(
      database,
      new ImmediateMessageBus(),
      successfulGitHub(fixture),
      { reviewBatch },
      new MemoryArtifactStore(),
      'https://app.example.test',
      'worker-invalid-model',
      { error: vi.fn(), info: vi.fn() },
    );
    workers.push(worker);
    await worker.start();
    await waitFor(
      async () =>
        (
          await database
            .selectFrom('review_runs')
            .select('status')
            .where('id', '=', fixture.runId)
            .executeTakeFirstOrThrow()
        ).status === 'FAILED',
      () => workflowSnapshot(database, fixture.runId),
    );
    expect(reviewBatch).toHaveBeenCalledTimes(2);
    await expect(
      database
        .selectFrom('tasks')
        .select(['status', 'task_type'])
        .where('task_type', '=', 'ANALYZE_REVIEW')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'FAILED',
      task_type: 'ANALYZE_REVIEW',
    });
  });

  it('does not retry GitHub authentication failures', async () => {
    const database = await createMemoryDatabase();
    databases.push(database);
    const fixture = await seedAcceptedReview(database);
    const worker = new ReviewWorker(
      database,
      new ImmediateMessageBus(),
      {
        ...successfulGitHub(fixture),
        createInstallationToken: vi
          .fn()
          .mockRejectedValue(new GitHubProviderError('AUTHENTICATION', 'denied', 401)),
      },
      { reviewBatch: successfulEmptyReview },
      new MemoryArtifactStore(),
      'https://app.example.test',
      'worker-auth-failure',
      { error: vi.fn(), info: vi.fn() },
    );
    workers.push(worker);
    await worker.start();
    await waitFor(
      async () =>
        (
          await database
            .selectFrom('review_runs')
            .select('status')
            .where('id', '=', fixture.runId)
            .executeTakeFirstOrThrow()
        ).status === 'FAILED',
      () => workflowSnapshot(database, fixture.runId),
    );
    await expect(
      database.selectFrom('task_attempts').select('error_code').executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      error_code: 'GITHUB_AUTHENTICATION',
    });
  });

  it('keeps a Check effect prepared when installation-token acquisition fails before the write', async () => {
    const database = await createMemoryDatabase();
    databases.push(database);
    const fixture = await seedAcceptedReview(database);
    const github = successfulGitHub(fixture);
    vi.mocked(github.createInstallationToken)
      .mockResolvedValueOnce({ expiresAt: 'later', permissions: {}, token: 'source-token' })
      .mockResolvedValueOnce({ expiresAt: 'later', permissions: {}, token: 'head-token' })
      .mockRejectedValueOnce(new GitHubProviderError('AUTHENTICATION', 'denied', 401));
    const worker = new ReviewWorker(
      database,
      new ImmediateMessageBus(),
      github,
      { reviewBatch: successfulEmptyReview },
      new MemoryArtifactStore(),
      'https://app.example.test',
      'worker-publish-auth-failure',
      { error: vi.fn(), info: vi.fn() },
    );
    workers.push(worker);
    await worker.start();
    await waitFor(
      async () =>
        (
          await database
            .selectFrom('review_runs')
            .select('status')
            .where('id', '=', fixture.runId)
            .executeTakeFirstOrThrow()
        ).status === 'FAILED',
      () => workflowSnapshot(database, fixture.runId),
    );

    await expect(
      database
        .selectFrom('external_effects')
        .select(['status', 'attempt_count'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ attempt_count: 0, status: 'PREPARED' });
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it('persists delayed retry intent for temporary source acquisition failures', async () => {
    const database = await createMemoryDatabase();
    databases.push(database);
    const fixture = await seedAcceptedReview(database);
    const worker = new ReviewWorker(
      database,
      new ImmediateMessageBus(),
      {
        ...successfulGitHub(fixture),
        getPullRequestSnapshot: vi.fn().mockRejectedValue(new Error('NETWORK_TEMPORARY')),
      },
      { reviewBatch: successfulEmptyReview },
      new MemoryArtifactStore(),
      'https://app.example.test',
      'worker-temporary-failure',
      { error: vi.fn(), info: vi.fn() },
    );
    workers.push(worker);
    await worker.start();
    await waitFor(
      async () =>
        (
          await database
            .selectFrom('tasks')
            .select('status')
            .where('id', '=', fixture.taskId)
            .executeTakeFirstOrThrow()
        ).status === 'RETRY_WAIT',
      () => workflowSnapshot(database, fixture.runId),
    );
    const retry = await database
      .selectFrom('outbox_events')
      .select(['available_at', 'causation_id', 'published_at'])
      .where('published_at', 'is', null)
      .executeTakeFirstOrThrow();
    expect(retry.causation_id).not.toBeNull();
    expect(new Date(retry.available_at).getTime()).toBeGreaterThan(Date.now());
  });
});

const successfulEmptyReview: ReviewModelProvider['reviewBatch'] = (request) =>
  Promise.resolve({
    inputHash: createHash('sha256').update(request.diff).digest('hex'),
    latencyMs: 1,
    output: { findings: [], summary: 'No model finding.' },
    usage: {},
  });

type ReviewFixture = Readonly<{
  baseSha: string;
  diff: string;
  headSha: string;
  runId: string;
  taskId: string;
}>;

function successfulGitHub(
  fixture: ReviewFixture,
): Pick<
  GitHubAppProvider,
  | 'createCheckRun'
  | 'createInstallationToken'
  | 'findCheckRunByExternalId'
  | 'getPullRequestHead'
  | 'getPullRequestSnapshot'
> {
  return {
    createCheckRun: vi.fn().mockResolvedValue('check'),
    createInstallationToken: vi
      .fn()
      .mockResolvedValue({ expiresAt: 'later', permissions: {}, token: 'installation' }),
    findCheckRunByExternalId: vi.fn().mockResolvedValue(undefined),
    getPullRequestHead: vi.fn().mockResolvedValue(fixture.headSha),
    getPullRequestSnapshot: vi.fn().mockResolvedValue({
      baseSha: fixture.baseSha,
      diff: fixture.diff,
      headSha: fixture.headSha,
    }),
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  diagnostics: () => Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`WORKFLOW_TIMEOUT:${JSON.stringify(await diagnostics())}`);
}

async function workflowSnapshot(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  runId: string,
): Promise<unknown> {
  const [run, tasks, attempts, outbox] = await Promise.all([
    database
      .selectFrom('review_runs')
      .select(['status', 'base_sha', 'head_sha'])
      .where('id', '=', runId)
      .executeTakeFirst(),
    database
      .selectFrom('tasks')
      .select(['task_type', 'status', 'attempt_count', 'available_at'])
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .execute(),
    database
      .selectFrom('task_attempts')
      .innerJoin('tasks', 'tasks.id', 'task_attempts.task_id')
      .select(['tasks.task_type', 'task_attempts.status', 'task_attempts.error_code'])
      .where('tasks.run_id', '=', runId)
      .orderBy('task_attempts.created_at')
      .execute(),
    database
      .selectFrom('outbox_events')
      .select(['event_type', 'published_at', 'available_at'])
      .where('correlation_id', '=', runId)
      .orderBy('available_at')
      .execute(),
  ]);
  return { attempts, outbox, run, tasks };
}

async function seedAcceptedReview(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
): Promise<ReviewFixture> {
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const taskId = randomUUID();
  const user = await database
    .insertInto('users')
    .values({ email: `${randomUUID()}@example.com`, status: 'ACTIVE' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database.insertInto('organizations').values({ id: organizationId, name: 'Test' }).execute();
  await database
    .insertInto('organization_members')
    .values({ organization_id: organizationId, role: 'OWNER', user_id: user.id })
    .execute();
  await database
    .insertInto('projects')
    .values({
      default_ruleset_version_id: null,
      id: projectId,
      name: 'Project',
      organization_id: organizationId,
      slug: 'project',
    })
    .execute();
  const ruleset = await database
    .insertInto('rulesets')
    .values({
      created_by: user.id,
      name: 'Default',
      organization_id: organizationId,
      project_id: projectId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const rules = [
    {
      appliesTo: { languages: [], paths: ['**/*'] },
      category: 'DEFECT',
      defaultSeverity: 'BLOCKING',
      deterministicHandler: 'security/github-token',
      evidenceRequirement: 'Added line',
      guidance: 'Detect GitHub tokens.',
      id: 'security/github-token',
      title: 'GitHub token',
    },
    {
      appliesTo: { languages: ['typescript'], paths: ['src/**'] },
      category: 'DEFECT',
      defaultSeverity: 'BLOCKING',
      evidenceRequirement: 'Added line',
      guidance: 'Find exposed credentials.',
      id: 'security/model-secret',
      title: 'Model credential rule',
    },
  ];
  const version = await database
    .insertInto('ruleset_versions')
    .values({
      content_hash: 'rules-hash',
      created_by: user.id,
      organization_id: organizationId,
      project_id: projectId,
      published_at: new Date(),
      rules: JSON.stringify(rules),
      ruleset_id: ruleset.id,
      status: 'PUBLISHED',
      version: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const repository = await database
    .insertInto('repository_connections')
    .values({
      installation_id: '10',
      organization_id: organizationId,
      owner_login: 'owner',
      permissions: {},
      project_id: projectId,
      repository_id: '20',
      repository_name: 'repo',
      status: 'ACTIVE',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database
    .insertInto('review_runs')
    .values({
      base_sha: null,
      completed_at: null,
      coverage_complete: false,
      diff_hash: null,
      head_sha: null,
      id: runId,
      model: 'deepseek-v4-flash',
      organization_id: organizationId,
      project_id: projectId,
      prompt_version: 'review-v1',
      pull_request_number: 7,
      repository_connection_id: repository.id,
      request_idempotency_key: 'worker-test',
      rerun_of_run_id: null,
      ruleset_version_id: version.id,
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
  return {
    baseSha: 'a'.repeat(40),
    diff: 'diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -0,0 +1,1 @@\n+const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";\n',
    headSha: 'b'.repeat(40),
    runId,
    taskId,
  };
}
