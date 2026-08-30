import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { completeTaskLease, createDatabase, reapExpiredTaskLeases } from '@delivery/database';
import { RabbitMqBus, reviewQueues } from '@delivery/messaging';

import { runReliabilityDrillChild } from './reliabilityDrillChild.js';
import {
  type ReliabilityIterationProof,
  type ReliabilityRuntimeConfig,
} from './reliabilityDrillContract.js';
import {
  loadAttemptSourceEventId,
  loadCurrentReliabilityLease,
  seedReliabilityReview,
} from './reliabilityDrillFixture.js';
import {
  assertDisposableDatabaseName,
  assertExclusiveReviewQueues,
  assertRabbitContainer,
  boundedInteger,
  createDisposableDatabase,
  createReliabilityArtifactStore,
  dropDisposableDatabase,
  migrateReliabilityDatabase,
  requiredEnvironment,
  restartRabbitBroker,
  reviewQueueDepths,
  spawnReliabilityChild,
  takeDeadLetter,
  waitForChildExit,
  waitForChildMessage,
  withDatabaseName,
} from './reliabilityDrillInfra.js';

const DATABASE_URL = requiredEnvironment('DATABASE_URL');
const RABBITMQ_URL = requiredEnvironment('RABBITMQ_URL');
const RABBIT_CONTAINER = requiredEnvironment('RELIABILITY_RABBIT_CONTAINER');
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENTRY_PATH = fileURLToPath(import.meta.url);
const PROOF_PATH =
  process.env.RELIABILITY_PROOF_PATH ??
  fileURLToPath(
    new URL(
      `../../../../.workspace/proofs/worker-reliability-${new Date().toISOString().replaceAll(':', '-')}.json`,
      import.meta.url,
    ),
  );

const runtimeConfig: ReliabilityRuntimeConfig = {
  databaseUrl: DATABASE_URL,
  rabbitContainer: RABBIT_CONTAINER,
  rabbitMqUrl: RABBITMQ_URL,
  repositoryRoot: REPOSITORY_ROOT,
};

async function runParent(): Promise<void> {
  assertRabbitContainer(runtimeConfig.rabbitContainer);
  const iterationCount = boundedInteger(
    process.env.RELIABILITY_ITERATIONS ?? '2',
    2,
    10,
    'RELIABILITY_ITERATIONS_INVALID',
  );
  const administratorDatabase = createDatabase(runtimeConfig.databaseUrl, 2);
  const results: ReliabilityIterationProof[] = [];
  try {
    await assertExclusiveReviewQueues(runtimeConfig.rabbitMqUrl);
    for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
      const databaseName = `delivery_reliability_${Date.now()}_${iteration}_${randomUUID().slice(0, 8)}`;
      assertDisposableDatabaseName(databaseName);
      const databaseUrl = withDatabaseName(runtimeConfig.databaseUrl, databaseName);
      await createDisposableDatabase(administratorDatabase, databaseName);
      try {
        await migrateReliabilityDatabase(runtimeConfig.repositoryRoot, databaseUrl);
        results.push(await runIteration(databaseUrl, iteration));
      } finally {
        await dropDisposableDatabase(administratorDatabase, databaseName);
      }
    }
  } finally {
    await administratorDatabase.destroy();
  }
  const proof = {
    drill: 'review-worker-multiprocess-recovery-v2',
    iterations: results,
    passed: results.length === iterationCount && results.every((result) => result.passed),
  };
  await mkdir(dirname(PROOF_PATH), { recursive: true });
  await writeFile(PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...proof, proofPath: PROOF_PATH })}\n`);
  if (!proof.passed) throw new Error('RELIABILITY_DRILL_FAILED');
}

async function runIteration(
  databaseUrl: string,
  iteration: number,
): Promise<ReliabilityIterationProof> {
  const database = createDatabase(databaseUrl);
  let consumer: ReturnType<typeof spawnReliabilityChild> | undefined;
  let artifactKeys: readonly string[] = [];
  try {
    const fixture = await seedReliabilityReview(database);
    const crashed = spawnReliabilityChild(ENTRY_PATH, '--child-hang', fixture, databaseUrl);
    await waitForChildMessage(crashed, 'ACQUIRE_ENTERED', 20_000);
    const staleLease = await loadCurrentReliabilityLease(database, fixture.taskId);
    crashed.kill('SIGKILL');
    await waitForChildExit(crashed, 10_000);

    await database
      .updateTable('task_attempts')
      .set({ lease_expires_at: new Date(0) })
      .where('id', '=', staleLease.attemptId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable('consumer_inbox')
      .set({ claimed_until: new Date(0) })
      .where('event_id', '=', await loadAttemptSourceEventId(database, staleLease.attemptId))
      .execute();
    const recoveryEventId = randomUUID();
    const recovered = await reapExpiredTaskLeases(database, (task) => ({
      ...(task.sourceEventId === undefined ? {} : { causationId: task.sourceEventId }),
      correlationId: task.runId,
      eventId: recoveryEventId,
      eventType: 'review.acquire.requested',
      organizationId: task.organizationId,
      payload: { runId: task.runId, taskId: task.taskId },
      projectId: task.projectId,
    }));
    const staleCompletionRejected = !(await completeTaskLease(database, staleLease));

    consumer = spawnReliabilityChild(ENTRY_PATH, '--child-complete', fixture, databaseUrl);
    const terminal = await waitForChildMessage(consumer, 'RUN_TERMINAL', 30_000);
    if (terminal.value !== 'SUCCEEDED') throw new Error(`RUN_DID_NOT_SUCCEED:${terminal.value}`);

    await restartRabbitBroker(runtimeConfig);
    const invalidEventId = randomUUID();
    await publishCommand({
      correlationId: fixture.runId,
      eventId: invalidEventId,
      organizationId: fixture.organizationId,
      payload: { runId: fixture.runId },
      projectId: fixture.projectId,
    });
    const deadLetter = await takeDeadLetter(
      runtimeConfig.rabbitMqUrl,
      reviewQueues.acquire,
      invalidEventId,
      15_000,
    );
    const replayEventId = randomUUID();
    await publishCommand({
      causationId: invalidEventId,
      correlationId: fixture.runId,
      eventId: replayEventId,
      organizationId: fixture.organizationId,
      payload: { runId: fixture.runId, taskId: fixture.taskId },
      projectId: fixture.projectId,
    });
    await waitForReplay(database, replayEventId);

    const [run, attempts, effects, artifacts, replayInbox, queueDepths] = await Promise.all([
      database
        .selectFrom('review_runs')
        .select(['status', 'coverage_complete'])
        .where('id', '=', fixture.runId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('task_attempts')
        .innerJoin('tasks', 'tasks.id', 'task_attempts.task_id')
        .select([
          'tasks.task_type as taskType',
          'task_attempts.attempt_number as attemptNumber',
          'task_attempts.fencing_token as fencingToken',
          'task_attempts.status',
          'task_attempts.error_code as errorCode',
        ])
        .where('tasks.run_id', '=', fixture.runId)
        .orderBy('task_attempts.created_at')
        .execute(),
      database
        .selectFrom('external_effects')
        .select(['logical_key as logicalKey', 'status', 'provider_object_id as providerObjectId'])
        .where('run_id', '=', fixture.runId)
        .execute(),
      database
        .selectFrom('artifacts')
        .select(['artifact_type as artifactType', 'object_key as objectKey'])
        .where('run_id', '=', fixture.runId)
        .execute(),
      database
        .selectFrom('consumer_inbox')
        .select(['event_id as eventId', 'result'])
        .where('event_id', '=', replayEventId)
        .executeTakeFirstOrThrow(),
      reviewQueueDepths(runtimeConfig.rabbitMqUrl),
    ]);
    artifactKeys = artifacts.map((artifact) => artifact.objectKey);
    const acquireAttempts = attempts.filter((attempt) => attempt.taskType === 'ACQUIRE_SOURCE');
    const passed =
      recovered.length === 1 &&
      staleCompletionRejected &&
      run.status === 'SUCCEEDED' &&
      acquireAttempts.length === 2 &&
      acquireAttempts[0]?.status === 'LEASE_EXPIRED' &&
      acquireAttempts[1]?.status === 'SUCCEEDED' &&
      effects.length === 1 &&
      effects[0]?.status === 'SUCCEEDED' &&
      replayInbox.result === 'NO_WORK' &&
      deadLetter.eventId === invalidEventId &&
      deadLetter.deathCount >= 1 &&
      Object.values(queueDepths).every((depth) => depth === 0);
    const proof: ReliabilityIterationProof = {
      artifactTypes: artifacts.map((artifact) => artifact.artifactType).toSorted(),
      brokerRestart: {
        consumerProcessRestarted: false,
        container: runtimeConfig.rabbitContainer,
      },
      deadLetter: {
        deathCount: deadLetter.deathCount,
        originalEventId: invalidEventId,
        queue: `${reviewQueues.acquire}.dlq`,
        replayCausationId: invalidEventId,
        replayEventId,
        replayResult: replayInbox.result,
      },
      externalEffects: effects,
      iteration,
      leaseRecovery: {
        attempts: acquireAttempts,
        reapedTasks: recovered.length,
        staleCompletionRejected,
      },
      passed,
      queueDepths,
      run,
      workerACrash: 'SIGKILL during ACQUIRE_SOURCE after lease acquisition',
    };
    if (!passed) throw new Error('RELIABILITY_DRILL_FAILED');
    return proof;
  } finally {
    if (consumer?.connected === true) consumer.send({ type: 'STOP' });
    if (consumer !== undefined) {
      await waitForChildExit(consumer, 10_000).catch(() => consumer?.kill());
    }
    if (artifactKeys.length > 0) {
      const store = createReliabilityArtifactStore();
      await Promise.all(artifactKeys.map((key) => store.delete(key)));
      store.close();
    }
    await database.destroy();
  }
}

async function publishCommand(input: {
  causationId?: string;
  correlationId: string;
  eventId: string;
  organizationId: string;
  payload: Record<string, unknown>;
  projectId: string;
}): Promise<void> {
  const bus = await RabbitMqBus.connect(runtimeConfig.rabbitMqUrl);
  try {
    await bus.publish({
      ...input,
      eventType: 'review.acquire.requested',
      eventVersion: 1,
      occurredAt: new Date(),
    });
  } finally {
    await bus.close();
  }
}

async function waitForReplay(
  database: ReturnType<typeof createDatabase>,
  replayEventId: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const inbox = await database
      .selectFrom('consumer_inbox')
      .select('result')
      .where('consumer_name', '=', 'review-worker-v1')
      .where('event_id', '=', replayEventId)
      .executeTakeFirst();
    if (inbox?.result === 'NO_WORK') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('DLQ_REPLAY_NOT_CONSUMED');
}

if (process.argv.includes('--child-hang')) await runReliabilityDrillChild('hang');
else if (process.argv.includes('--child-complete')) await runReliabilityDrillChild('complete');
else await runParent();
