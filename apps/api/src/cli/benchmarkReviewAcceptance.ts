import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createDatabase, sql, type DeliveryDatabase } from '@delivery/database';
import { createLogger } from '@delivery/observability';
import {
  AccessTokenService,
  issueOpaqueToken,
  RefreshTokenService,
  type JwtSigningKey,
  type JwtVerificationKey,
} from '@delivery/security';

import { AdminService } from '../application/adminService.js';
import { AuthService } from '../application/authService.js';
import { ControlPlaneService } from '../application/controlPlaneService.js';
import { PublicAuthRateLimiter } from '../application/publicAuthRateLimiter.js';
import { RegistrationService } from '../application/registrationService.js';
import { createApp } from '../app.js';
import { type M1Runtime } from '../modules/m1Router.js';

type BenchmarkOptions = Readonly<{
  concurrency: number;
  databaseUrl: string;
  outputPath: string;
  p95TargetMilliseconds: number;
  requestCount: number;
}>;

type RequestMeasurement = Readonly<{ latencyMilliseconds: number; status: number }>;

type BenchmarkDatabaseEvidence = Readonly<{
  activeRuns: number;
  auditEvents: number;
  databaseBlockHits: number;
  databaseBlockReads: number;
  databaseDeadlocks: number;
  databaseRollbacks: number;
  outboxEvents: number;
  outboxOldestAgeMilliseconds: number;
  reviewRuns: number;
  tasks: number;
  waitingLocks: number;
}>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name}_MUST_BE_AN_INTEGER_BETWEEN_1_AND_${maximum}`);
  }
  return value;
}

function loadOptions(): BenchmarkOptions {
  if (process.env.BENCHMARK_CONFIRM_DISPOSABLE_DATABASE !== 'true') {
    throw new Error('BENCHMARK_CONFIRM_DISPOSABLE_DATABASE_MUST_BE_TRUE');
  }
  const databaseUrl = requiredEnvironment('BENCHMARK_DATABASE_URL');
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  if (!databaseName.startsWith('delivery_benchmark_')) {
    throw new Error('BENCHMARK_DATABASE_NAME_MUST_START_WITH_delivery_benchmark_');
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return {
    concurrency: positiveInteger('BENCHMARK_CONCURRENCY', 100, 500),
    databaseUrl,
    outputPath:
      process.env.BENCHMARK_OUTPUT_PATH ??
      resolve(
        import.meta.dirname,
        '../../../../.workspace/proofs',
        `review-acceptance-${timestamp}.json`,
      ),
    p95TargetMilliseconds: positiveInteger('BENCHMARK_P95_TARGET_MS', 500, 60_000),
    requestCount: positiveInteger('BENCHMARK_REQUESTS', 10_000, 100_000),
  };
}

function createSigningKey(keyId: string): JwtSigningKey & JwtVerificationKey {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
}

async function seedBenchmark(
  database: DeliveryDatabase,
  tokenPepper: string,
): Promise<Readonly<{ projectId: string; repositoryConnectionId: string; token: string }>> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const rulesetId = randomUUID();
  const rulesetVersionId = randomUUID();
  const repositoryConnectionId = randomUUID();
  const tokenId = randomUUID();
  const issuedToken = issueOpaqueToken(`iwpat-${tokenId}`, tokenPepper);

  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('users')
      .values({
        email: `benchmark-${userId}@example.invalid`,
        id: userId,
        platform_role: 'USER',
        status: 'ACTIVE',
      })
      .execute();
    await transaction
      .insertInto('organizations')
      .values({ id: organizationId, name: 'Review acceptance benchmark' })
      .execute();
    await transaction
      .insertInto('organization_members')
      .values({ organization_id: organizationId, role: 'OWNER', user_id: userId })
      .execute();
    await transaction
      .insertInto('projects')
      .values({
        default_ruleset_version_id: null,
        id: projectId,
        name: 'Review benchmark',
        organization_id: organizationId,
        slug: `benchmark-${projectId.slice(0, 8)}`,
      })
      .execute();
    await transaction
      .insertInto('rulesets')
      .values({
        created_by: userId,
        id: rulesetId,
        name: 'Benchmark rules',
        organization_id: organizationId,
        project_id: projectId,
      })
      .execute();
    await transaction
      .insertInto('ruleset_versions')
      .values({
        content_hash: createHash('sha256').update('[]').digest('hex'),
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
    await transaction
      .updateTable('projects')
      .set({ default_ruleset_version_id: rulesetVersionId })
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('repository_connections')
      .values({
        id: repositoryConnectionId,
        installation_id: '1',
        organization_id: organizationId,
        owner_login: 'benchmark',
        permissions: {},
        project_id: projectId,
        repository_id: '1',
        repository_name: 'review-load',
        status: 'ACTIVE',
      })
      .execute();
    await transaction
      .insertInto('project_api_tokens')
      .values({
        created_by: userId,
        expires_at: null,
        id: tokenId,
        name: 'Benchmark trigger',
        organization_id: organizationId,
        project_id: projectId,
        revoked_at: null,
        scopes: ['review:trigger'],
        token_hash: issuedToken.hash,
        token_prefix: issuedToken.prefix,
      })
      .execute();
  });
  return { projectId, repositoryConnectionId, token: issuedToken.token };
}

function createRuntime(database: DeliveryDatabase, tokenPepper: string): M1Runtime {
  const accessKey = createSigningKey('benchmark-access');
  const refreshKey = createSigningKey('benchmark-refresh');
  const rateLimiter = new PublicAuthRateLimiter(database, tokenPepper);
  return {
    admin: new AdminService(database),
    artifactStore: {
      get: () => Promise.reject(new Error('BENCHMARK_ARTIFACT_READ_NOT_AVAILABLE')),
    },
    auth: new AuthService(
      database,
      new AccessTokenService(
        { current: accessKey, verificationKeys: [accessKey] },
        'benchmark',
        'benchmark-access',
      ),
      new RefreshTokenService(
        { current: refreshKey, verificationKeys: [refreshKey] },
        'benchmark',
        'benchmark-refresh',
      ),
      tokenPepper,
      rateLimiter,
    ),
    controlPlane: new ControlPlaneService(database, tokenPepper, randomBytes(32)),
    github: {
      createInstallationToken: () =>
        Promise.reject(new Error('BENCHMARK_GITHUB_WRITE_NOT_AVAILABLE')),
      getRepository: () => Promise.reject(new Error('BENCHMARK_GITHUB_READ_NOT_AVAILABLE')),
    },
    githubAppSlug: 'benchmark',
    githubWebhookSecret: randomBytes(32).toString('hex'),
    registration: new RegistrationService(
      database,
      tokenPepper,
      { key: randomBytes(32), version: 1 },
      rateLimiter,
    ),
    secureCookies: false,
    webOrigin: 'http://127.0.0.1',
  };
}

async function measureRequest(
  url: string,
  token: string,
  repositoryConnectionId: string,
  sequence: number,
): Promise<RequestMeasurement> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      body: JSON.stringify({
        source: {
          pullRequestNumber: 1,
          repositoryConnectionId,
          type: 'github_pull_request',
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': `benchmark-${sequence.toString().padStart(8, '0')}`,
      },
      method: 'POST',
    });
    await response.arrayBuffer();
    return { latencyMilliseconds: performance.now() - startedAt, status: response.status };
  } catch {
    return { latencyMilliseconds: performance.now() - startedAt, status: 0 };
  }
}

async function cancelAcceptedRuns(database: DeliveryDatabase, projectId: string): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`
      UPDATE review_runs
      SET
        base_sha = substring(md5(id::text) || md5('base-' || id::text), 1, 40),
        completed_at = now(),
        diff_hash = md5('diff-' || id::text),
        head_sha = substring(md5('head-' || id::text) || md5(id::text), 1, 40),
        status = 'CANCELLED',
        version = version + 1
      WHERE project_id = ${projectId} AND status = 'ACCEPTED'
    `.execute(transaction);
    await sql`
      UPDATE tasks
      SET status = 'CANCELLED', version = version + 1
      WHERE project_id = ${projectId} AND status IN ('PENDING', 'RETRY_WAIT')
    `.execute(transaction);
  });
}

function percentile(sorted: readonly number[], proportion: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1);
  return sorted[index] ?? 0;
}

async function databaseEvidence(
  database: DeliveryDatabase,
  projectId: string,
): Promise<BenchmarkDatabaseEvidence> {
  const [runs, activeRuns, tasks, outbox, audits, databaseStats, waitingLocks] = await Promise.all([
    database
      .selectFrom('review_runs')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom('review_runs')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('project_id', '=', projectId)
      .where('status', 'in', ['ACCEPTED', 'QUEUED', 'RUNNING'])
      .executeTakeFirstOrThrow(),
    database
      .selectFrom('tasks')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom('outbox_events')
      .select(({ fn }) => [
        fn.countAll().as('count'),
        sql<string>`COALESCE(
          EXTRACT(EPOCH FROM (now() - min(occurred_at))) * 1000,
          0
        )`.as('oldest_age_milliseconds'),
      ])
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom('audit_events')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('project_id', '=', projectId)
      .where('action', '=', 'review.accepted')
      .executeTakeFirstOrThrow(),
    sql<{ blks_hit: string; blks_read: string; deadlocks: string; xact_rollback: string }>`
      SELECT blks_hit, blks_read, deadlocks, xact_rollback
      FROM pg_stat_database WHERE datname = current_database()
    `.execute(database),
    sql<{ count: string }>`SELECT count(*) AS count FROM pg_locks WHERE NOT granted`.execute(
      database,
    ),
  ]);
  const stats = databaseStats.rows[0];
  return {
    activeRuns: Number(activeRuns.count),
    auditEvents: Number(audits.count),
    databaseBlockHits: Number(stats?.blks_hit ?? 0),
    databaseBlockReads: Number(stats?.blks_read ?? 0),
    databaseDeadlocks: Number(stats?.deadlocks ?? 0),
    databaseRollbacks: Number(stats?.xact_rollback ?? 0),
    outboxEvents: Number(outbox.count),
    outboxOldestAgeMilliseconds: Math.round(Number(outbox.oldest_age_milliseconds)),
    reviewRuns: Number(runs.count),
    tasks: Number(tasks.count),
    waitingLocks: Number(waitingLocks.rows[0]?.count ?? 0),
  };
}

async function closeServer(
  server: ReturnType<ReturnType<typeof createApp>['listen']>,
): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

async function main(): Promise<void> {
  const options = loadOptions();
  const database = createDatabase(options.databaseUrl, Math.min(options.concurrency, 100));
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  try {
    const tokenPepper = randomBytes(32).toString('hex');
    const fixture = await seedBenchmark(database, tokenPepper);
    const app = createApp({
      logger: createLogger('review-acceptance-benchmark', 'silent'),
      m1Runtime: createRuntime(database, tokenPepper),
      readinessProbe: {
        check: () => Promise.resolve({ dependencies: {}, ready: true }),
        close: () => Promise.resolve(),
      },
      serviceName: 'review-acceptance-benchmark',
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('BENCHMARK_SERVER_ADDRESS_INVALID');
    }
    const url = `http://127.0.0.1:${address.port}/api/v1/projects/${fixture.projectId}/reviews`;
    const measurements: RequestMeasurement[] = [];
    const statusCounts = new Map<number, number>();
    const startedAt = performance.now();
    for (let offset = 0; offset < options.requestCount; offset += options.concurrency) {
      const batchSize = Math.min(options.concurrency, options.requestCount - offset);
      const batch = await Promise.all(
        Array.from({ length: batchSize }, (_, index) =>
          measureRequest(url, fixture.token, fixture.repositoryConnectionId, offset + index),
        ),
      );
      measurements.push(...batch);
      for (const measurement of batch) {
        statusCounts.set(measurement.status, (statusCounts.get(measurement.status) ?? 0) + 1);
      }
      if (offset + batchSize < options.requestCount) {
        await cancelAcceptedRuns(database, fixture.projectId);
      }
    }
    const durationMilliseconds = performance.now() - startedAt;
    const sortedLatencies = measurements
      .map((measurement) => measurement.latencyMilliseconds)
      .toSorted((left, right) => left - right);
    const evidence = await databaseEvidence(database, fixture.projectId);
    const p95Milliseconds = percentile(sortedLatencies, 0.95);
    const acceptedRequests = statusCounts.get(202) ?? 0;
    const passed =
      acceptedRequests === options.requestCount &&
      evidence.reviewRuns === options.requestCount &&
      evidence.activeRuns <= options.concurrency &&
      p95Milliseconds < options.p95TargetMilliseconds;
    const report = {
      benchmark: 'review-acceptance-v1',
      completedAt: new Date().toISOString(),
      configuration: {
        concurrency: options.concurrency,
        p95TargetMilliseconds: options.p95TargetMilliseconds,
        requestCount: options.requestCount,
      },
      database: evidence,
      durationMilliseconds: Math.round(durationMilliseconds),
      latencyMilliseconds: {
        maximum: Math.round(percentile(sortedLatencies, 1) * 100) / 100,
        p50: Math.round(percentile(sortedLatencies, 0.5) * 100) / 100,
        p95: Math.round(p95Milliseconds * 100) / 100,
        p99: Math.round(percentile(sortedLatencies, 0.99) * 100) / 100,
      },
      passed,
      requestsPerSecond:
        Math.round((options.requestCount / (durationMilliseconds / 1_000)) * 100) / 100,
      statusCounts: Object.fromEntries(
        [...statusCounts.entries()].map(([status, count]) => [String(status), count]),
      ),
    };
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ ...report, outputPath: options.outputPath }, null, 2)}\n`,
    );
    if (!passed) process.exitCode = 1;
  } finally {
    if (server !== undefined) await closeServer(server);
    await database.destroy();
  }
}

await main();
