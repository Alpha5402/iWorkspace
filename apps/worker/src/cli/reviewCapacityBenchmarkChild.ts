import { createHash } from 'node:crypto';

import { createDatabase } from '@delivery/database';
import { RabbitMqBus } from '@delivery/messaging';

import { ReviewWorker } from '../reviewWorker.js';
import {
  CAPACITY_BASE_SHA,
  CAPACITY_DIFF,
  CAPACITY_HEAD_SHA,
  type CapacityWorkerMessage,
} from './reviewCapacityBenchmarkContract.js';
import { createReliabilityArtifactStore, requiredEnvironment } from './reliabilityDrillInfra.js';

export async function runCapacityWorker(): Promise<void> {
  const database = createDatabase(requiredEnvironment('DATABASE_URL'));
  const bus = await RabbitMqBus.connect(requiredEnvironment('RABBITMQ_URL'));
  const artifacts = createReliabilityArtifactStore();
  const workerId = requiredEnvironment('CAPACITY_WORKER_ID');
  const providerDelayMilliseconds = Number(requiredEnvironment('CAPACITY_PROVIDER_DELAY_MS'));
  const inputTokens = Number(requiredEnvironment('CAPACITY_INPUT_TOKENS'));
  const outputTokens = Number(requiredEnvironment('CAPACITY_OUTPUT_TOKENS'));
  const worker = new ReviewWorker(
    database,
    bus,
    {
      createCheckRun: (request) => Promise.resolve(`capacity-check-${request.externalId}`),
      createInstallationToken: () =>
        Promise.resolve({ expiresAt: '2099-01-01T00:00:00.000Z', permissions: {}, token: 'stub' }),
      findCheckRunByExternalId: () => Promise.resolve(undefined),
      getPullRequestHead: () => Promise.resolve(CAPACITY_HEAD_SHA),
      getPullRequestSnapshot: () =>
        Promise.resolve({
          baseSha: CAPACITY_BASE_SHA,
          diff: CAPACITY_DIFF,
          headSha: CAPACITY_HEAD_SHA,
        }),
    },
    {
      reviewBatch: async (request) => {
        await delay(providerDelayMilliseconds);
        return {
          inputHash: createHash('sha256')
            .update(`${request.model}:${request.category}:${request.diff}`)
            .digest('hex'),
          latencyMs: providerDelayMilliseconds,
          output: { findings: [], summary: 'No findings in capacity benchmark.' },
          usage: { inputTokens, outputTokens },
        };
      },
    },
    artifacts,
    'https://capacity.example.invalid',
    workerId,
    {
      error: (attributes, message) =>
        process.stderr.write(`${workerId}:${message}:${JSON.stringify(attributes)}\n`),
      info: () => undefined,
    },
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await worker.close();
    await database.destroy();
    send({ type: 'STOPPED', workerId });
    process.exit(0);
  };
  process.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'STOP'
    ) {
      void stop();
    }
  });
  process.on('uncaughtException', (error) => {
    send({ message: error.message, type: 'ERROR', workerId });
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    send({
      message: error instanceof Error ? error.message : String(error),
      type: 'ERROR',
      workerId,
    });
    process.exit(1);
  });

  await worker.start();
  send({ type: 'READY', workerId });
}

function send(message: CapacityWorkerMessage): void {
  process.send?.(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
