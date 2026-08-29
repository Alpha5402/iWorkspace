import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  createDatabase,
  createPlatformAdminDatabase,
  sql,
  type DeliveryDatabase,
} from '@delivery/database';
import { type UserSessionPrincipal } from '@delivery/security';
import { z } from 'zod';

import { AdminService } from '../application/adminService.js';

type BenchmarkOptions = Readonly<{
  databaseUrl: string;
  iterations: number;
  outputPath: string;
  p95TargetMilliseconds: number;
  userCount: number;
}>;

type ScenarioResult = Readonly<{
  maximumMilliseconds: number;
  p50Milliseconds: number;
  p95Milliseconds: number;
}>;

type PlanEvidence = Readonly<{
  executionMilliseconds: number;
  expectedIndex: string;
  indexUsed: boolean;
  name: string;
}>;

const ExplainSchema = z
  .array(
    z.object({
      'Execution Time': z.number().nonnegative(),
      Plan: z.looseObject({}),
    }),
  )
  .length(1);

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
  if (!databaseName.startsWith('delivery_benchmark_admin_')) {
    throw new Error('BENCHMARK_DATABASE_NAME_MUST_START_WITH_delivery_benchmark_admin_');
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return {
    databaseUrl,
    iterations: positiveInteger('BENCHMARK_ITERATIONS', 100, 10_000),
    outputPath:
      process.env.BENCHMARK_OUTPUT_PATH ??
      resolve(
        import.meta.dirname,
        '../../../../.workspace/proofs',
        `admin-user-list-${timestamp}.json`,
      ),
    p95TargetMilliseconds: positiveInteger('BENCHMARK_P95_TARGET_MS', 25, 60_000),
    userCount: positiveInteger('BENCHMARK_USERS', 100_000, 1_000_000),
  };
}

async function seedUsers(
  database: DeliveryDatabase,
  userCount: number,
): Promise<Readonly<{ actor: UserSessionPrincipal; emailProbe: string }>> {
  const actorId = randomUUID();
  await database
    .insertInto('users')
    .values({
      email: 'benchmark-admin@example.invalid',
      id: actorId,
      platform_role: 'SUPER_ADMIN',
      status: 'ACTIVE',
    })
    .executeTakeFirstOrThrow();
  if (userCount > 1) {
    await sql`
      INSERT INTO users (id, email, status, platform_role, created_at, updated_at)
      SELECT
        md5('benchmark-user-' || sequence::text)::uuid,
        'benchmark-user-' || sequence || '@example.invalid',
        CASE WHEN sequence % 10 = 0 THEN 'SUSPENDED' ELSE 'ACTIVE' END,
        (CASE WHEN sequence % 101 = 0 THEN 'ADMIN' ELSE 'USER' END)::platform_role,
        now() - make_interval(secs => sequence),
        now() - make_interval(secs => sequence)
      FROM generate_series(1, ${userCount - 1}) AS sequence
    `.execute(database);
  }
  await sql`ANALYZE users`.execute(database);
  return {
    actor: {
      organizationId: randomUUID(),
      sessionId: randomUUID(),
      type: 'USER_SESSION',
      userId: actorId,
    },
    emailProbe: `benchmark-user-${Math.max(1, Math.floor(userCount / 2))}@example.invalid`,
  };
}

function percentile(sorted: readonly number[], proportion: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1);
  return sorted[index] ?? 0;
}

async function measureScenario(
  iterations: number,
  operation: () => Promise<unknown>,
): Promise<ScenarioResult> {
  const measurements: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    await operation();
    measurements.push(performance.now() - startedAt);
  }
  const sorted = measurements.toSorted((left, right) => left - right);
  const rounded = (value: number): number => Math.round(value * 100) / 100;
  return {
    maximumMilliseconds: rounded(percentile(sorted, 1)),
    p50Milliseconds: rounded(percentile(sorted, 0.5)),
    p95Milliseconds: rounded(percentile(sorted, 0.95)),
  };
}

async function explain(
  database: DeliveryDatabase,
  name: string,
  expectedIndex: string,
  statement: ReturnType<typeof sql>,
): Promise<PlanEvidence> {
  const explained = await sql<{ 'QUERY PLAN': unknown }>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}
  `.execute(database);
  const parsed = ExplainSchema.parse(explained.rows[0]?.['QUERY PLAN']);
  const plan = parsed[0];
  if (plan === undefined) throw new Error('EXPLAIN_PLAN_REQUIRED');
  return {
    executionMilliseconds: Math.round(plan['Execution Time'] * 100) / 100,
    expectedIndex,
    indexUsed: JSON.stringify(plan.Plan).includes(`"Index Name":"${expectedIndex}"`),
    name,
  };
}

async function collectPlanEvidence(database: DeliveryDatabase): Promise<readonly PlanEvidence[]> {
  const selection = sql`created_at, email, id, platform_role, status, updated_at`;
  return Promise.all([
    explain(
      database,
      'unfiltered',
      'users_admin_created_id_idx',
      sql`SELECT ${selection} FROM users ORDER BY created_at DESC, id DESC LIMIT 51`,
    ),
    explain(
      database,
      'suspended',
      'users_admin_created_id_idx',
      sql`SELECT ${selection} FROM users WHERE status = 'SUSPENDED' ORDER BY created_at DESC, id DESC LIMIT 51`,
    ),
    explain(
      database,
      'administrator-role',
      'users_admin_created_id_idx',
      sql`SELECT ${selection} FROM users WHERE platform_role = 'ADMIN' ORDER BY created_at DESC, id DESC LIMIT 51`,
    ),
    explain(
      database,
      'exact-email',
      'users_email_canonical_key',
      sql`SELECT ${selection} FROM users WHERE email_canonical = 'benchmark-user-50000@example.invalid' ORDER BY created_at DESC, id DESC LIMIT 51`,
    ),
  ]);
}

async function main(): Promise<void> {
  const options = loadOptions();
  const migratorDatabase = createDatabase(options.databaseUrl);
  let administratorDatabase: DeliveryDatabase | undefined;
  try {
    const fixture = await seedUsers(migratorDatabase, options.userCount);
    administratorDatabase = createPlatformAdminDatabase(options.databaseUrl);
    const service = new AdminService(administratorDatabase);
    const role = await sql<{ role: string }>`SELECT current_user AS role`
      .execute(administratorDatabase)
      .then((result) => result.rows[0]?.role ?? 'unknown');
    const scenarios = {
      administratorRole: await measureScenario(options.iterations, () =>
        service.listUsers(fixture.actor, { limit: 50, platformRole: 'ADMIN' }),
      ),
      exactEmail: await measureScenario(options.iterations, () =>
        service.listUsers(fixture.actor, { email: fixture.emailProbe, limit: 50 }),
      ),
      suspended: await measureScenario(options.iterations, () =>
        service.listUsers(fixture.actor, { limit: 50, status: 'SUSPENDED' }),
      ),
      unfiltered: await measureScenario(options.iterations, () =>
        service.listUsers(fixture.actor, { limit: 50 }),
      ),
    };
    const plans = await collectPlanEvidence(administratorDatabase);
    const sizes = await sql<{ index_bytes: string; table_bytes: string }>`
      SELECT
        pg_relation_size('users_admin_created_id_idx')::text AS index_bytes,
        pg_relation_size('users')::text AS table_bytes
    `.execute(administratorDatabase);
    const databaseSizes = sizes.rows[0];
    if (databaseSizes === undefined) throw new Error('DATABASE_SIZE_EVIDENCE_REQUIRED');
    const passed =
      role === 'iw_platform_admin' &&
      Object.values(scenarios).every(
        (scenario) => scenario.p95Milliseconds < options.p95TargetMilliseconds,
      ) &&
      plans.every((plan) => plan.indexUsed);
    const report = {
      benchmark: 'admin-user-list-v1',
      completedAt: new Date().toISOString(),
      configuration: {
        iterationsPerScenario: options.iterations,
        p95TargetMilliseconds: options.p95TargetMilliseconds,
        userCount: options.userCount,
      },
      databaseRole: role,
      databaseSizes: {
        orderingIndexBytes: Number(databaseSizes.index_bytes),
        usersTableBytes: Number(databaseSizes.table_bytes),
      },
      passed,
      plans,
      scenarios,
    };
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ ...report, outputPath: options.outputPath }, null, 2)}\n`,
    );
    if (!passed) process.exitCode = 1;
  } finally {
    await administratorDatabase?.destroy();
    await migratorDatabase.destroy();
  }
}

await main();
