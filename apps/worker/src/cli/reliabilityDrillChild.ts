import { createHash } from 'node:crypto';

import { createDatabase } from '@delivery/database';
import { RabbitMqBus } from '@delivery/messaging';

import { ReviewWorker } from '../reviewWorker.js';
import {
  BASE_SHA,
  DIFF,
  HEAD_SHA,
  ReliabilityFixtureSchema,
  TERMINAL_STATUSES,
  type ReliabilityChildMessage,
} from './reliabilityDrillContract.js';
import { createReliabilityArtifactStore, requiredEnvironment } from './reliabilityDrillInfra.js';

export async function runReliabilityDrillChild(mode: 'hang' | 'complete'): Promise<void> {
  const databaseUrl = requiredEnvironment('DATABASE_URL');
  const rabbitMqUrl = requiredEnvironment('RABBITMQ_URL');
  const fixture = ReliabilityFixtureSchema.parse(
    JSON.parse(requiredEnvironment('RELIABILITY_FIXTURE')) as unknown,
  );
  const database = createDatabase(databaseUrl);
  const store = createReliabilityArtifactStore();
  const bus = await RabbitMqBus.connect(rabbitMqUrl);
  const worker = new ReviewWorker(
    database,
    bus,
    {
      createCheckRun: () => Promise.resolve(`drill-check-${fixture.runId}`),
      createInstallationToken: () =>
        Promise.resolve({ expiresAt: '2099-01-01T00:00:00.000Z', permissions: {}, token: 'stub' }),
      findCheckRunByExternalId: () => Promise.resolve(undefined),
      getPullRequestHead: () => Promise.resolve(HEAD_SHA),
      getPullRequestSnapshot: async () => {
        if (mode === 'hang') {
          send({ type: 'ACQUIRE_ENTERED' });
          await new Promise<never>(() => undefined);
        }
        return { baseSha: BASE_SHA, diff: DIFF, headSha: HEAD_SHA };
      },
    },
    {
      reviewBatch: (request) =>
        Promise.resolve({
          inputHash: createHash('sha256').update(request.diff).digest('hex'),
          latencyMs: 1,
          output: { findings: [], summary: 'No findings in reliability drill.' },
          usage: {},
        }),
    },
    store,
    'https://app.example.invalid',
    `reliability-${mode}-${process.pid}`,
    {
      error: (attributes, message) =>
        process.stderr.write(`${message}:${JSON.stringify(attributes)}\n`),
      info: () => undefined,
    },
  );
  const shutdown = async (): Promise<void> => {
    await worker.close();
    await database.destroy();
    send({ type: 'STOPPED' });
    process.exit(0);
  };
  process.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'STOP'
    ) {
      void shutdown();
    }
  });
  process.on('uncaughtException', (error) => {
    send({ type: 'CHILD_ERROR', value: error.message });
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    send({ type: 'CHILD_ERROR', value: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
  await worker.start();
  if (mode === 'complete') {
    await waitForTerminalRun(database, fixture.runId);
    const run = await database
      .selectFrom('review_runs')
      .select('status')
      .where('id', '=', fixture.runId)
      .executeTakeFirstOrThrow();
    send({ type: 'RUN_TERMINAL', value: run.status });
  }
}

async function waitForTerminalRun(
  database: ReturnType<typeof createDatabase>,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = await database
      .selectFrom('review_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    if (TERMINAL_STATUSES.has(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('CHILD_RUN_TIMEOUT');
}

function send(message: ReliabilityChildMessage): void {
  process.send?.(message);
}
