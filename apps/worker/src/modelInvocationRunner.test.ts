import { ModelProviderError, type ReviewModelProvider } from '@delivery/providers-agent';
import { acquireProviderCapacityLease, releaseProviderCapacityLease } from '@delivery/database';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelInvocationRunner } from './modelInvocationRunner.js';

vi.mock('@delivery/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delivery/database')>()),
  acquireProviderCapacityLease: vi.fn().mockResolvedValue(0),
  releaseProviderCapacityLease: vi.fn().mockResolvedValue(undefined),
}));

const context = {
  lease: {
    attemptId: crypto.randomUUID(),
    fencingToken: '1',
    taskId: crypto.randomUUID(),
    taskType: 'ANALYZE_REVIEW',
  },
  model: 'deepseek-v4-flash',
  organizationId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  promptVersion: 'review-v1',
  request: {
    category: 'DEFECT' as const,
    diff: '+const token = "secret"',
    promptVersion: 'review-v1',
    rules: [
      {
        evidenceRequirement: 'line',
        guidance: 'review',
        id: 'defect/test',
        severity: 'MAJOR' as const,
        title: 'Test',
      },
    ],
  },
  runId: crypto.randomUUID(),
};

describe('ModelInvocationRunner', () => {
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(acquireProviderCapacityLease).mockResolvedValue(0);
    database = await createMemoryDatabase();
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('performs exactly one schema-repair call and records both physical invocations', async () => {
    const reviewBatch = vi
      .fn<ReviewModelProvider['reviewBatch']>()
      .mockRejectedValueOnce(new ModelProviderError('INVALID_RESPONSE', 'missing findings'))
      .mockResolvedValueOnce({
        inputHash: 'valid-input-hash',
        latencyMs: 25,
        output: { findings: [], summary: 'Repaired.' },
        providerResponseId: 'response-2',
        usage: { inputTokens: 20, outputTokens: 4 },
      });
    const runner = new ModelInvocationRunner(database, { reviewBatch }, () => Promise.resolve());

    await expect(runner.invoke(context)).resolves.toMatchObject({
      providerResponseId: 'response-2',
    });
    expect(reviewBatch).toHaveBeenCalledTimes(2);
    expect(reviewBatch.mock.calls[1]?.[0]).toMatchObject({ repairInstruction: 'missing findings' });
    const invocations = await database
      .selectFrom('provider_invocations')
      .select(['status', 'error_code', 'provider_response_id'])
      .orderBy('created_at')
      .execute();
    expect(invocations).toEqual([
      { error_code: 'MODEL_INVALID_RESPONSE', provider_response_id: null, status: 'FAILED' },
      { error_code: null, provider_response_id: 'response-2', status: 'SUCCEEDED' },
    ]);
  });

  it('does not repair rate limits and records the classified failure', async () => {
    const error = new ModelProviderError('RATE_LIMITED', 'slow down', 7);
    const reviewBatch = vi.fn<ReviewModelProvider['reviewBatch']>().mockRejectedValue(error);
    const runner = new ModelInvocationRunner(database, { reviewBatch }, () => Promise.resolve());

    await expect(runner.invoke(context)).rejects.toBe(error);
    expect(reviewBatch).toHaveBeenCalledOnce();
    await expect(
      database
        .selectFrom('provider_invocations')
        .select(['status', 'error_code'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ error_code: 'MODEL_RATE_LIMITED', status: 'FAILED' });
  });

  it('rejects when distributed provider capacity is exhausted before calling the model', async () => {
    vi.mocked(acquireProviderCapacityLease).mockResolvedValueOnce(undefined);
    const reviewBatch = vi.fn<ReviewModelProvider['reviewBatch']>();
    const runner = new ModelInvocationRunner(database, { reviewBatch }, () => Promise.resolve());

    await expect(runner.invoke(context)).rejects.toThrow('PROVIDER_CAPACITY_EXHAUSTED');
    expect(reviewBatch).not.toHaveBeenCalled();
    expect(releaseProviderCapacityLease).not.toHaveBeenCalled();
    await expect(
      database.selectFrom('provider_invocations').select('error_code').executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      error_code: 'PROVIDER_CAPACITY_EXHAUSTED',
    });
  });

  it.each([
    [new Error('transport failed'), 'transport failed'],
    ['opaque failure', 'UNKNOWN_PROVIDER_ERROR'],
  ])('records stable error codes for non-provider failures', async (failure, errorCode) => {
    const reviewBatch = vi.fn<ReviewModelProvider['reviewBatch']>().mockRejectedValue(failure);
    const runner = new ModelInvocationRunner(database, { reviewBatch }, () => Promise.resolve());
    await expect(runner.invoke(context)).rejects.toBe(failure);
    await expect(
      database.selectFrom('provider_invocations').select('error_code').executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      error_code: errorCode,
    });
  });
});
