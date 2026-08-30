import { fork, spawn, type ChildProcess } from 'node:child_process';

import { type DeliveryDatabase, sql } from '@delivery/database';
import { reviewQueues } from '@delivery/messaging';
import { ImmutableArtifactStore } from '@delivery/object-storage';
import { z } from 'zod';

import {
  ReliabilityChildMessageSchema,
  type ReliabilityChildMessage,
  type ReliabilityFixture,
  type ReliabilityRuntimeConfig,
} from './reliabilityDrillContract.js';

const RabbitGetResponseSchema = z.array(
  z.object({
    payload: z.string(),
    properties: z
      .object({
        headers: z
          .object({
            'x-death': z.array(z.object({ count: z.number().optional() })).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
);

const RabbitQueueStateSchema = z.object({
  consumers: z.number().int().nonnegative().default(0),
  messages: z.number().int().nonnegative().default(0),
});

const EnvelopeIdSchema = z.object({ eventId: z.uuid() });

export async function assertExclusiveReviewQueues(rabbitMqUrl: string): Promise<void> {
  for (const queue of Object.values(reviewQueues)) {
    const state = await getQueueState(rabbitMqUrl, queue);
    if (state.consumers !== 0 || state.messages !== 0) {
      throw new Error(`RELIABILITY_QUEUE_NOT_EXCLUSIVE:${queue}`);
    }
    const deadLetterState = await getQueueState(rabbitMqUrl, `${queue}.dlq`);
    if (deadLetterState.consumers !== 0 || deadLetterState.messages !== 0) {
      throw new Error(`RELIABILITY_DLQ_NOT_EMPTY:${queue}`);
    }
  }
}

export async function restartRabbitBroker(config: ReliabilityRuntimeConfig): Promise<void> {
  await runCommand('docker', ['restart', config.rabbitContainer], config.repositoryRoot);
  await waitFor(
    async () => {
      try {
        return (await rabbitManagement(config.rabbitMqUrl, '/api/overview')).ok;
      } catch {
        return false;
      }
    },
    30_000,
    'RABBIT_BROKER_RESTART_TIMEOUT',
  );
}

export async function takeDeadLetter(
  rabbitMqUrl: string,
  queue: string,
  expectedEventId: string,
  timeout: number,
): Promise<Readonly<{ deathCount: number; eventId: string }>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await rabbitManagement(
      rabbitMqUrl,
      `/api/queues/%2F/${encodeURIComponent(`${queue}.dlq`)}/get`,
      {
        method: 'POST',
        body: JSON.stringify({
          ackmode: 'ack_requeue_false',
          count: 1,
          encoding: 'auto',
          truncate: 100_000,
        }),
      },
    );
    const messages = RabbitGetResponseSchema.parse(await response.json());
    const message = messages[0];
    if (message !== undefined) {
      const envelope = EnvelopeIdSchema.parse(JSON.parse(message.payload) as unknown);
      if (envelope.eventId !== expectedEventId) {
        throw new Error(`UNEXPECTED_DLQ_EVENT:${envelope.eventId}`);
      }
      return {
        deathCount: message.properties?.headers?.['x-death']?.[0]?.count ?? 0,
        eventId: envelope.eventId,
      };
    }
    await delay(100);
  }
  throw new Error('DLQ_MESSAGE_TIMEOUT');
}

export async function reviewQueueDepths(
  rabbitMqUrl: string,
): Promise<Readonly<Record<string, number>>> {
  const queueNames = Object.values(reviewQueues).flatMap((queue) => [queue, `${queue}.dlq`]);
  const entries = await Promise.all(
    queueNames.map(async (queue) => {
      const state = await getQueueState(rabbitMqUrl, queue);
      return [queue, state.messages] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function createDisposableDatabase(
  administratorDatabase: DeliveryDatabase,
  databaseName: string,
): Promise<void> {
  assertDisposableDatabaseName(databaseName);
  await sql.raw(`create database "${databaseName}"`).execute(administratorDatabase);
}

export async function dropDisposableDatabase(
  administratorDatabase: DeliveryDatabase,
  databaseName: string,
): Promise<void> {
  assertDisposableDatabaseName(databaseName);
  await sql`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = ${databaseName} and pid <> pg_backend_pid()
  `.execute(administratorDatabase);
  await sql.raw(`drop database if exists "${databaseName}"`).execute(administratorDatabase);
}

export async function migrateReliabilityDatabase(
  repositoryRoot: string,
  databaseUrl: string,
): Promise<void> {
  await runCommand('pnpm', ['--filter', '@delivery/database', 'migrate', 'up'], repositoryRoot, {
    ...process.env,
    DATABASE_URL: databaseUrl,
  });
}

export function spawnReliabilityChild(
  entryPath: string,
  argument: '--child-hang' | '--child-complete',
  fixture: ReliabilityFixture,
  databaseUrl: string,
): ChildProcess {
  return fork(entryPath, [argument], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      RELIABILITY_FIXTURE: JSON.stringify(fixture),
    },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

export async function waitForChildMessage(
  child: ChildProcess,
  type: ReliabilityChildMessage['type'],
  timeout: number,
): Promise<ReliabilityChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CHILD_MESSAGE_TIMEOUT:${type}`));
    }, timeout);
    child.once('exit', (code, signal) => {
      reject(new Error(`CHILD_EXITED:${String(code)}:${String(signal)}`));
    });
    child.stderr?.on('data', (chunk: unknown) => {
      process.stderr.write(Buffer.isBuffer(chunk) ? chunk : String(chunk));
    });
    child.on('message', (message: unknown) => {
      const parsed = ReliabilityChildMessageSchema.parse(message);
      if (parsed.type === 'CHILD_ERROR') reject(new Error(`CHILD_ERROR:${parsed.value}`));
      if (parsed.type !== type) return;
      clearTimeout(timer);
      resolve({
        type: parsed.type,
        ...(parsed.value === undefined ? {} : { value: parsed.value }),
      });
    });
  });
}

export async function waitForChildExit(child: ChildProcess, timeout: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('CHILD_EXIT_TIMEOUT'));
    }, timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function createReliabilityArtifactStore(): ImmutableArtifactStore {
  return new ImmutableArtifactStore({
    accessKeyId: requiredEnvironment('S3_ACCESS_KEY'),
    bucket: requiredEnvironment('S3_BUCKET'),
    endpoint: requiredEnvironment('S3_ENDPOINT'),
    region: requiredEnvironment('S3_REGION'),
    secretAccessKey: requiredEnvironment('S3_SECRET_KEY'),
  });
}

export function assertDisposableDatabaseName(databaseName: string): void {
  if (!/^delivery_reliability_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('RELIABILITY_DATABASE_NAME_INVALID');
  }
}

export function assertRabbitContainer(containerName: string): void {
  if (!/^delivery-control-plane-rabbitmq-[a-z0-9_-]+$/.test(containerName)) {
    throw new Error('RELIABILITY_RABBIT_CONTAINER_INVALID');
  }
}

export function withDatabaseName(databaseUrl: string, databaseName: string): string {
  assertDisposableDatabaseName(databaseName);
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export function boundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  errorCode: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(errorCode);
  }
  return parsed;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function getQueueState(
  rabbitMqUrl: string,
  queue: string,
): Promise<z.infer<typeof RabbitQueueStateSchema>> {
  const response = await rabbitManagement(
    rabbitMqUrl,
    `/api/queues/%2F/${encodeURIComponent(queue)}`,
  );
  return RabbitQueueStateSchema.parse(await response.json());
}

async function rabbitManagement(
  rabbitMqUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(rabbitMqUrl);
  const headers = new Headers(init.headers);
  headers.set(
    'Authorization',
    `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`,
  );
  headers.set('content-type', 'application/json');
  const response = await fetch(`http://${url.hostname}:15672${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`RABBIT_MANAGEMENT_HTTP_${response.status}`);
  return response;
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(output).toString('utf8').slice(-4_000);
      reject(
        new Error(
          `COMMAND_FAILED:${command}:${String(code)}:${String(signal)}`,
          detail.length === 0 ? undefined : { cause: new Error(detail) },
        ),
      );
    });
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeout: number,
  errorCode: string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(errorCode);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
