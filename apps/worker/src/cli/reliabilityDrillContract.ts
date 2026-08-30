import { z } from 'zod';

export const BASE_SHA = 'a'.repeat(40);
export const HEAD_SHA = 'b'.repeat(40);
export const DIFF =
  'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -0,0 +1,1 @@\n+export const value = 42;\n';
export const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'STALE']);

export type ReliabilityFixture = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  taskId: string;
}>;

export const ReliabilityFixtureSchema = z.object({
  organizationId: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  taskId: z.uuid(),
});

export type ReliabilityChildMessage = Readonly<{
  type: 'ACQUIRE_ENTERED' | 'RUN_TERMINAL' | 'STOPPED' | 'CHILD_ERROR';
  value?: string;
}>;

export const ReliabilityChildMessageSchema = z.object({
  type: z.enum(['ACQUIRE_ENTERED', 'RUN_TERMINAL', 'STOPPED', 'CHILD_ERROR']),
  value: z.string().optional(),
});

export type ReliabilityIterationProof = Readonly<{
  artifactTypes: readonly string[];
  brokerRestart: Readonly<{ consumerProcessRestarted: false; container: string }>;
  deadLetter: Readonly<{
    deathCount: number;
    originalEventId: string;
    queue: string;
    replayCausationId: string;
    replayEventId: string;
    replayResult: string | null;
  }>;
  externalEffects: readonly unknown[];
  iteration: number;
  leaseRecovery: Readonly<{
    attempts: readonly unknown[];
    reapedTasks: number;
    staleCompletionRejected: boolean;
  }>;
  passed: boolean;
  queueDepths: Readonly<Record<string, number>>;
  run: unknown;
  workerACrash: string;
}>;

export type ReliabilityRuntimeConfig = Readonly<{
  databaseUrl: string;
  rabbitMqUrl: string;
  repositoryRoot: string;
  rabbitContainer: string;
}>;
