import { createHash } from 'node:crypto';

import {
  acquireProviderCapacityLease,
  releaseProviderCapacityLease,
  type DeliveryDatabase,
  type TaskLease,
} from '@delivery/database';
import {
  ModelProviderError,
  type ReviewModelProvider,
  type ReviewModelRequest,
  type ReviewModelResult,
} from '@delivery/providers-agent';

type InvocationContext = Readonly<{
  lease: TaskLease;
  model: string;
  organizationId: string;
  projectId: string;
  promptVersion: string;
  request: Omit<ReviewModelRequest, 'model'>;
  runId: string;
}>;

type CapacityWaitOptions = Readonly<{
  maximumPollMilliseconds: number;
  minimumPollMilliseconds: number;
  timeoutMilliseconds: number;
}>;

const DEFAULT_CAPACITY_WAIT: CapacityWaitOptions = {
  maximumPollMilliseconds: 250,
  minimumPollMilliseconds: 100,
  timeoutMilliseconds: 180_000,
};

export class ModelInvocationRunner {
  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly provider: ReviewModelProvider,
    private readonly assertLease: (lease: TaskLease) => Promise<void>,
    private readonly capacityWait: CapacityWaitOptions = DEFAULT_CAPACITY_WAIT,
  ) {}

  public async invoke(
    context: InvocationContext,
  ): Promise<ReviewModelResult & Readonly<{ invocationId: string }>> {
    let repairInstruction: string | undefined;
    for (let callNumber = 1; callNumber <= 2; callNumber += 1) {
      await this.assertLease(context.lease);
      const request = {
        ...context.request,
        model: context.model,
        ...(repairInstruction === undefined ? {} : { repairInstruction }),
      };
      const invocation = await this.database
        .insertInto('provider_invocations')
        .values({
          completed_at: null,
          error_code: null,
          input_hash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
          input_tokens: null,
          latency_ms: null,
          model: context.model,
          organization_id: context.organizationId,
          output_tokens: null,
          project_id: context.projectId,
          prompt_version: context.promptVersion,
          provider: 'deepseek',
          provider_response_id: null,
          run_id: context.runId,
          schema_version: 'review-result-v1',
          status: 'STARTED',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      try {
        const result = await this.withCapacity(context, () =>
          this.provider.reviewBatch(request, AbortSignal.timeout(180_000)),
        );
        await this.assertLease(context.lease);
        await this.database
          .updateTable('provider_invocations')
          .set({
            completed_at: new Date(),
            input_hash: result.inputHash,
            input_tokens: result.usage.inputTokens ?? null,
            latency_ms: result.latencyMs,
            output_tokens: result.usage.outputTokens ?? null,
            provider_response_id: result.providerResponseId ?? null,
            status: 'SUCCEEDED',
          })
          .where('id', '=', invocation.id)
          .where('status', '=', 'STARTED')
          .executeTakeFirstOrThrow();
        return { ...result, invocationId: invocation.id };
      } catch (error) {
        await this.database
          .updateTable('provider_invocations')
          .set({
            completed_at: new Date(),
            error_code: this.errorCode(error),
            status: 'FAILED',
          })
          .where('id', '=', invocation.id)
          .where('status', '=', 'STARTED')
          .execute();
        if (
          error instanceof ModelProviderError &&
          error.code === 'INVALID_RESPONSE' &&
          callNumber === 1
        ) {
          repairInstruction = error.message;
          continue;
        }
        throw error;
      }
    }
    throw new Error('MODEL_REPAIR_LOOP_EXHAUSTED');
  }

  private async withCapacity<T>(
    context: InvocationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + this.capacityWait.timeoutMilliseconds;
    const acquire = (): Promise<number | undefined> =>
      acquireProviderCapacityLease(this.database, {
        attemptId: context.lease.attemptId,
        globalLimit: 4,
        leaseSeconds: 210,
        projectId: context.projectId,
        projectLimit: 2,
        provider: 'deepseek',
      });
    await this.assertLease(context.lease);
    let slot = await acquire();
    while (slot === undefined) {
      if (Date.now() >= deadline) throw new Error('PROVIDER_CAPACITY_WAIT_TIMEOUT');
      await delay(this.nextCapacityPollMilliseconds());
      await this.assertLease(context.lease);
      slot = await acquire();
    }
    try {
      return await operation();
    } finally {
      await releaseProviderCapacityLease(this.database, 'deepseek', context.lease.attemptId);
    }
  }

  private nextCapacityPollMilliseconds(): number {
    const range =
      this.capacityWait.maximumPollMilliseconds - this.capacityWait.minimumPollMilliseconds;
    return this.capacityWait.minimumPollMilliseconds + Math.floor(Math.random() * (range + 1));
  }

  private errorCode(error: unknown): string {
    if (error instanceof ModelProviderError) return `MODEL_${error.code}`;
    return error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN_PROVIDER_ERROR';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
