import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase, type DeliveryDatabase } from '@delivery/database';

import { runCapacityWorker } from './reviewCapacityBenchmarkChild.js';
import {
  CapacityWorkerMessageSchema,
  type CapacitySeed,
} from './reviewCapacityBenchmarkContract.js';
import { collectCapacityEvidence, withoutArtifactKeys } from './reviewCapacityBenchmarkEvidence.js';
import { seedCapacityBenchmark } from './reviewCapacityBenchmarkFixture.js';
import {
  assertExclusiveReviewQueues,
  boundedInteger,
  createDisposableDatabase,
  createReliabilityArtifactStore,
  dropDisposableDatabase,
  migrateReliabilityDatabase,
  requiredEnvironment,
  reviewQueueDepths,
  waitForChildExit,
  withDatabaseName,
} from './reliabilityDrillInfra.js';

type BenchmarkOptions = Readonly<{
  databaseUrl: string;
  inputPriceUsdPerMillion: number;
  inputTokensPerInvocation: number;
  maximumDurationMilliseconds: number;
  outputPath: string;
  outputPriceUsdPerMillion: number;
  outputTokensPerInvocation: number;
  projectCount: number;
  providerDelayMilliseconds: number;
  rabbitMqUrl: string;
  runCount: number;
  workerCount: number;
}>;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENTRY_PATH = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const options = loadOptions();
  await assertExclusiveReviewQueues(options.rabbitMqUrl);
  const administratorDatabase = createDatabase(options.databaseUrl, 2);
  const databaseName = `delivery_reliability_capacity_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const databaseUrl = withDatabaseName(options.databaseUrl, databaseName);
  let database: DeliveryDatabase | undefined;
  let workers: readonly ChildProcess[] = [];
  let artifactKeys: readonly string[] = [];
  try {
    await createDisposableDatabase(administratorDatabase, databaseName);
    await migrateReliabilityDatabase(REPOSITORY_ROOT, databaseUrl);
    database = createDatabase(databaseUrl, 20);
    const seed = await seedCapacityBenchmark(database, options.runCount, options.projectCount);
    const startedAt = performance.now();
    workers = Array.from({ length: options.workerCount }, (_, index) =>
      spawnWorker(databaseUrl, options, index + 1),
    );
    await Promise.all(workers.map((worker) => waitForWorkerReady(worker, 20_000)));
    const queuePeaks = await waitForTerminalRuns(database, seed, workers, options);
    const durationMilliseconds = performance.now() - startedAt;
    await stopWorkers(workers);
    workers = [];

    const evidence = await collectCapacityEvidence(database, seed, queuePeaks, options);
    artifactKeys = evidence.artifactKeys;
    const passed =
      evidence.runStatuses.SUCCEEDED === options.runCount &&
      evidence.runStatuses.other === 0 &&
      evidence.taskStatuses.SUCCEEDED === options.runCount * 4 &&
      evidence.taskStatuses.other === 0 &&
      evidence.externalEffects.succeeded === options.runCount &&
      evidence.externalEffects.total === options.runCount &&
      evidence.inbox.completed === options.runCount * 4 &&
      evidence.inbox.total === options.runCount * 4 &&
      evidence.artifacts.total === options.runCount * 7 &&
      evidence.provider.succeeded >= options.runCount * 3 &&
      evidence.provider.maximumGlobalConcurrency <= 4 &&
      evidence.provider.maximumGlobalConcurrency >= 2 &&
      Object.values(evidence.provider.maximumConcurrencyByProject).every(
        (concurrency) => concurrency <= 2,
      ) &&
      evidence.provider.activeCapacityLeases === 0 &&
      evidence.provider.capacityWaitTimeouts === 0 &&
      evidence.outbox.unpublished === 0 &&
      Object.values(evidence.queues.finalDepths).every((depth) => depth === 0) &&
      durationMilliseconds <= options.maximumDurationMilliseconds;
    const report = {
      benchmark: 'review-capacity-v1',
      completedAt: new Date().toISOString(),
      configuration: {
        inputTokensPerInvocation: options.inputTokensPerInvocation,
        maximumDurationMilliseconds: options.maximumDurationMilliseconds,
        outputTokensPerInvocation: options.outputTokensPerInvocation,
        projectCount: options.projectCount,
        providerDelayMilliseconds: options.providerDelayMilliseconds,
        runCount: options.runCount,
        workerCount: options.workerCount,
      },
      durationMilliseconds: round(durationMilliseconds),
      evidence: withoutArtifactKeys(evidence),
      passed,
      runsPerSecond: round(options.runCount / (durationMilliseconds / 1_000)),
      scope: {
        externalProviders: 'CONTROLLED_STUBS',
        infrastructure: ['PostgreSQL', 'RabbitMQ', 'MinIO', 'multi-process ReviewWorker'],
        validationLevel: 'LOCAL_INFRASTRUCTURE_BASELINE',
      },
    };
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ ...report, outputPath: options.outputPath }, null, 2)}\n`,
    );
    if (!passed) process.exitCode = 1;
  } finally {
    await stopWorkers(workers);
    if (artifactKeys.length > 0) await deleteArtifacts(artifactKeys);
    await database?.destroy();
    await dropDisposableDatabase(administratorDatabase, databaseName).catch(() => undefined);
    await administratorDatabase.destroy();
  }
}

function loadOptions(): BenchmarkOptions {
  if (process.env.CAPACITY_CONFIRM_DISPOSABLE_DATABASE !== 'true') {
    throw new Error('CAPACITY_CONFIRM_DISPOSABLE_DATABASE_MUST_BE_TRUE');
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return {
    databaseUrl: requiredEnvironment('DATABASE_URL'),
    inputPriceUsdPerMillion: nonnegativeNumber('CAPACITY_INPUT_USD_PER_MILLION', 0.44),
    inputTokensPerInvocation: boundedInteger(
      process.env.CAPACITY_INPUT_TOKENS ?? '120',
      1,
      1_000_000,
      'CAPACITY_INPUT_TOKENS_INVALID',
    ),
    maximumDurationMilliseconds: boundedInteger(
      process.env.CAPACITY_MAX_DURATION_MS ?? '120000',
      10_000,
      600_000,
      'CAPACITY_MAX_DURATION_MS_INVALID',
    ),
    outputPath:
      process.env.CAPACITY_PROOF_PATH ??
      fileURLToPath(
        new URL(`../../../../.workspace/proofs/review-capacity-${timestamp}.json`, import.meta.url),
      ),
    outputPriceUsdPerMillion: nonnegativeNumber('CAPACITY_OUTPUT_USD_PER_MILLION', 1.32),
    outputTokensPerInvocation: boundedInteger(
      process.env.CAPACITY_OUTPUT_TOKENS ?? '30',
      1,
      1_000_000,
      'CAPACITY_OUTPUT_TOKENS_INVALID',
    ),
    projectCount: boundedInteger(
      process.env.CAPACITY_PROJECTS ?? '2',
      2,
      20,
      'CAPACITY_PROJECTS_INVALID',
    ),
    providerDelayMilliseconds: boundedInteger(
      process.env.CAPACITY_PROVIDER_DELAY_MS ?? '200',
      10,
      10_000,
      'CAPACITY_PROVIDER_DELAY_MS_INVALID',
    ),
    rabbitMqUrl: requiredEnvironment('RABBITMQ_URL'),
    runCount: boundedInteger(process.env.CAPACITY_RUNS ?? '100', 2, 1_000, 'CAPACITY_RUNS_INVALID'),
    workerCount: boundedInteger(
      process.env.CAPACITY_WORKERS ?? '8',
      2,
      32,
      'CAPACITY_WORKERS_INVALID',
    ),
  };
}

async function waitForTerminalRuns(
  database: DeliveryDatabase,
  seed: CapacitySeed,
  workers: readonly ChildProcess[],
  options: BenchmarkOptions,
): Promise<Readonly<Record<string, number>>> {
  const deadline = Date.now() + options.maximumDurationMilliseconds;
  const peaks: Record<string, number> = {};
  while (Date.now() < deadline) {
    for (const worker of workers) {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        throw new Error('CAPACITY_WORKER_EXITED_BEFORE_COMPLETION');
      }
    }
    const [terminal, depths] = await Promise.all([
      database
        .selectFrom('review_runs')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('id', 'in', seed.runIds)
        .where('status', 'in', ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'STALE'])
        .executeTakeFirstOrThrow(),
      reviewQueueDepths(options.rabbitMqUrl),
    ]);
    for (const [queue, depth] of Object.entries(depths)) {
      peaks[queue] = Math.max(peaks[queue] ?? 0, depth);
    }
    if (
      Number(terminal.count) === options.runCount &&
      Object.values(depths).every((depth) => depth === 0)
    ) {
      return peaks;
    }
    await delay(100);
  }
  throw new Error('CAPACITY_RUN_TIMEOUT');
}

function spawnWorker(
  databaseUrl: string,
  options: BenchmarkOptions,
  sequence: number,
): ChildProcess {
  const workerId = `capacity-${sequence}-${randomUUID().slice(0, 8)}`;
  const child = fork(ENTRY_PATH, ['--child'], {
    env: {
      ...process.env,
      CAPACITY_INPUT_TOKENS: String(options.inputTokensPerInvocation),
      CAPACITY_OUTPUT_TOKENS: String(options.outputTokensPerInvocation),
      CAPACITY_PROVIDER_DELAY_MS: String(options.providerDelayMilliseconds),
      CAPACITY_WORKER_ID: workerId,
      DATABASE_URL: databaseUrl,
    },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (chunk: unknown) => {
    process.stderr.write(Buffer.isBuffer(chunk) ? chunk : String(chunk));
  });
  return child;
}

async function waitForWorkerReady(child: ChildProcess, timeout: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('CAPACITY_WORKER_READY_TIMEOUT'));
    }, timeout);
    child.once('exit', (code, signal) => {
      reject(new Error(`CAPACITY_WORKER_EXITED:${String(code)}:${String(signal)}`));
    });
    child.on('message', (message: unknown) => {
      const parsed = CapacityWorkerMessageSchema.parse(message);
      if (parsed.type === 'ERROR') reject(new Error(`CAPACITY_WORKER_ERROR:${parsed.message}`));
      if (parsed.type !== 'READY') return;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopWorkers(workers: readonly ChildProcess[]): Promise<void> {
  await Promise.all(
    workers.map(async (worker) => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      worker.send({ type: 'STOP' });
      await waitForChildExit(worker, 10_000).catch(() => worker.kill('SIGKILL'));
    }),
  );
}

async function deleteArtifacts(keys: readonly string[]): Promise<void> {
  const store = createReliabilityArtifactStore();
  try {
    for (let offset = 0; offset < keys.length; offset += 50) {
      await Promise.all(keys.slice(offset, offset + 50).map((key) => store.delete(key)));
    }
  } finally {
    store.close();
  }
}

function nonnegativeNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}_INVALID`);
  return value;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv.includes('--child')) await runCapacityWorker();
else await main();
