import { sql, type DeliveryDatabase } from '@delivery/database';

import { type CapacitySeed } from './reviewCapacityBenchmarkContract.js';
import { reviewQueueDepths } from './reliabilityDrillInfra.js';

type MetricDistribution = Readonly<{
  maximum: number;
  p50: number;
  p95: number;
  sampleCount: number;
}>;

type TimedInvocation = Readonly<{
  completedAtMilliseconds: number;
  projectId: string;
  startedAtMilliseconds: number;
}>;

export type CapacityEvidence = Readonly<{
  artifactKeys: readonly string[];
  artifacts: Readonly<{ byType: Readonly<Record<string, number>>; total: number }>;
  externalEffects: Readonly<{ succeeded: number; total: number }>;
  inbox: Readonly<{
    completed: number;
    results: Readonly<Record<string, number>>;
    total: number;
  }>;
  outbox: Readonly<{
    publishLatencyMilliseconds: MetricDistribution;
    total: number;
    unpublished: number;
  }>;
  provider: Readonly<{
    activeCapacityLeases: number;
    capacityWaitTimeouts: number;
    estimatedPeakCostUsd: number;
    failed: number;
    inputPriceUsdPerMillion: number;
    inputTokens: number;
    maximumConcurrencyByProject: Readonly<Record<string, number>>;
    maximumGlobalConcurrency: number;
    outputPriceUsdPerMillion: number;
    outputTokens: number;
    priceBasis: string;
    priceSource: string;
    queueWaitMilliseconds: MetricDistribution;
    succeeded: number;
  }>;
  queues: Readonly<{
    finalDepths: Readonly<Record<string, number>>;
    peakDepths: Readonly<Record<string, number>>;
  }>;
  runDurationMilliseconds: MetricDistribution;
  runStatuses: Readonly<{ SUCCEEDED: number; other: number }>;
  taskQueueWaitMilliseconds: MetricDistribution;
  taskStatuses: Readonly<{ SUCCEEDED: number; other: number }>;
}>;

export async function collectCapacityEvidence(
  database: DeliveryDatabase,
  seed: CapacitySeed,
  queuePeaks: Readonly<Record<string, number>>,
  options: Readonly<{
    inputPriceUsdPerMillion: number;
    outputPriceUsdPerMillion: number;
    rabbitMqUrl: string;
  }>,
): Promise<CapacityEvidence> {
  const [
    runs,
    tasks,
    attempts,
    outbox,
    inbox,
    invocations,
    effects,
    artifacts,
    capacityLeases,
    finalDepths,
  ] = await Promise.all([
    database
      .selectFrom('review_runs')
      .select([
        'id',
        'status',
        sql<string>`COALESCE(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000, -1)`.as(
          'durationMilliseconds',
        ),
      ])
      .where('id', 'in', seed.runIds)
      .execute(),
    database
      .selectFrom('tasks')
      .select([
        'id',
        'status',
        sql<string>`EXTRACT(EPOCH FROM created_at) * 1000`.as('createdAtMilliseconds'),
      ])
      .where('run_id', 'in', seed.runIds)
      .execute(),
    database
      .selectFrom('task_attempts')
      .innerJoin('tasks', 'tasks.id', 'task_attempts.task_id')
      .select([
        'task_attempts.task_id as taskId',
        sql<string>`EXTRACT(EPOCH FROM task_attempts.created_at) * 1000`.as(
          'createdAtMilliseconds',
        ),
      ])
      .where('tasks.run_id', 'in', seed.runIds)
      .execute(),
    database
      .selectFrom('outbox_events')
      .select([
        'published_at as publishedAt',
        sql<string>`COALESCE(EXTRACT(EPOCH FROM (published_at - occurred_at)) * 1000, -1)`.as(
          'publishLatencyMilliseconds',
        ),
      ])
      .where('correlation_id', 'in', seed.runIds)
      .execute(),
    database
      .selectFrom('consumer_inbox')
      .select(['completed_at as completedAt', 'result'])
      .where('consumer_name', '=', 'review-worker-v1')
      .execute(),
    database
      .selectFrom('provider_invocations')
      .select([
        'status',
        'error_code as errorCode',
        'input_tokens as inputTokens',
        'latency_ms as latencyMilliseconds',
        'output_tokens as outputTokens',
        'project_id as projectId',
        sql<string>`EXTRACT(EPOCH FROM created_at) * 1000`.as('queuedAtMilliseconds'),
        sql<string>`COALESCE(EXTRACT(EPOCH FROM completed_at) * 1000, -1)`.as(
          'completedAtMilliseconds',
        ),
      ])
      .where('run_id', 'in', seed.runIds)
      .execute(),
    database
      .selectFrom('external_effects')
      .select('status')
      .where('run_id', 'in', seed.runIds)
      .execute(),
    database
      .selectFrom('artifacts')
      .select(['object_key as objectKey', 'artifact_type as artifactType'])
      .where('run_id', 'in', seed.runIds)
      .execute(),
    database
      .selectFrom('provider_capacity_leases')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
    reviewQueueDepths(options.rabbitMqUrl),
  ]);
  const firstAttemptByTask = new Map<string, number>();
  for (const attempt of attempts) {
    const createdAtMilliseconds = Number(attempt.createdAtMilliseconds);
    const current = firstAttemptByTask.get(attempt.taskId);
    if (current === undefined || createdAtMilliseconds < current) {
      firstAttemptByTask.set(attempt.taskId, createdAtMilliseconds);
    }
  }
  const queueWaits = tasks.flatMap((task) => {
    const firstAttempt = firstAttemptByTask.get(task.id);
    return firstAttempt === undefined ? [] : [firstAttempt - Number(task.createdAtMilliseconds)];
  });
  const publishLatencies = outbox.flatMap((event) =>
    event.publishedAt === null ? [] : [Number(event.publishLatencyMilliseconds)],
  );
  const runDurations = runs
    .map((run) => Number(run.durationMilliseconds))
    .filter((duration) => duration >= 0);
  const succeededInvocations = invocations
    .filter(
      (invocation) =>
        invocation.status === 'SUCCEEDED' && Number(invocation.completedAtMilliseconds) >= 0,
    )
    .map((invocation) => ({
      ...invocation,
      completedAtMilliseconds: Number(invocation.completedAtMilliseconds),
      queuedAtMilliseconds: Number(invocation.queuedAtMilliseconds),
      startedAtMilliseconds:
        Number(invocation.completedAtMilliseconds) - (invocation.latencyMilliseconds ?? 0),
    }));
  const providerQueueWaits = succeededInvocations.map(
    (invocation) => invocation.startedAtMilliseconds - invocation.queuedAtMilliseconds,
  );
  const inputTokens = succeededInvocations.reduce(
    (total, invocation) => total + (invocation.inputTokens ?? 0),
    0,
  );
  const outputTokens = succeededInvocations.reduce(
    (total, invocation) => total + (invocation.outputTokens ?? 0),
    0,
  );
  return {
    artifactKeys: artifacts.map((artifact) => artifact.objectKey),
    artifacts: {
      byType: countValues(artifacts.map((artifact) => artifact.artifactType)),
      total: artifacts.length,
    },
    externalEffects: {
      succeeded: effects.filter((effect) => effect.status === 'SUCCEEDED').length,
      total: effects.length,
    },
    inbox: {
      completed: inbox.filter((receipt) => receipt.completedAt !== null).length,
      results: countValues(inbox.map((receipt) => receipt.result ?? 'PENDING')),
      total: inbox.length,
    },
    outbox: {
      publishLatencyMilliseconds: distribution(publishLatencies),
      total: outbox.length,
      unpublished: outbox.filter((event) => event.publishedAt === null).length,
    },
    provider: {
      activeCapacityLeases: Number(capacityLeases.count),
      capacityWaitTimeouts: invocations.filter(
        (invocation) => invocation.errorCode === 'PROVIDER_CAPACITY_WAIT_TIMEOUT',
      ).length,
      estimatedPeakCostUsd: round(
        (inputTokens / 1_000_000) * options.inputPriceUsdPerMillion +
          (outputTokens / 1_000_000) * options.outputPriceUsdPerMillion,
        6,
      ),
      failed: invocations.filter((invocation) => invocation.status === 'FAILED').length,
      inputPriceUsdPerMillion: options.inputPriceUsdPerMillion,
      inputTokens,
      maximumConcurrencyByProject: Object.fromEntries(
        seed.projectIds.map((projectId) => [
          projectId,
          maximumConcurrency(
            succeededInvocations.filter((invocation) => invocation.projectId === projectId),
          ),
        ]),
      ),
      maximumGlobalConcurrency: maximumConcurrency(succeededInvocations),
      outputPriceUsdPerMillion: options.outputPriceUsdPerMillion,
      outputTokens,
      priceBasis: 'DeepSeek V4 Flash peak cache-miss rates sampled 2026-08-30; estimate only',
      priceSource: 'https://api-docs.deepseek.com/quick_start/pricing/',
      queueWaitMilliseconds: distribution(providerQueueWaits),
      succeeded: succeededInvocations.length,
    },
    queues: { finalDepths, peakDepths: queuePeaks },
    runDurationMilliseconds: distribution(runDurations),
    runStatuses: {
      SUCCEEDED: runs.filter((run) => run.status === 'SUCCEEDED').length,
      other: runs.filter((run) => run.status !== 'SUCCEEDED').length,
    },
    taskQueueWaitMilliseconds: distribution(queueWaits),
    taskStatuses: {
      SUCCEEDED: tasks.filter((task) => task.status === 'SUCCEEDED').length,
      other: tasks.filter((task) => task.status !== 'SUCCEEDED').length,
    },
  };
}

export function withoutArtifactKeys(evidence: CapacityEvidence): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'artifactKeys'));
}

function maximumConcurrency(invocations: readonly TimedInvocation[]): number {
  const events = invocations
    .flatMap((invocation) => [
      { delta: 1, time: invocation.startedAtMilliseconds },
      { delta: -1, time: invocation.completedAtMilliseconds },
    ])
    .toSorted((left, right) => left.time - right.time || left.delta - right.delta);
  let current = 0;
  let maximum = 0;
  for (const event of events) {
    current += event.delta;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function distribution(values: readonly number[]): MetricDistribution {
  const sorted = values.toSorted((left, right) => left - right);
  return {
    maximum: round(percentile(sorted, 1)),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    sampleCount: sorted.length,
  };
}

function percentile(sorted: readonly number[], proportion: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1);
  return sorted[index] ?? 0;
}

function countValues(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(counts);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
