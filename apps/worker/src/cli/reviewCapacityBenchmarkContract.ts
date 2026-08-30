import { z } from 'zod';

export const CAPACITY_BASE_SHA = 'c'.repeat(40);
export const CAPACITY_HEAD_SHA = 'd'.repeat(40);
export const CAPACITY_DIFF =
  'diff --git a/src/capacity.ts b/src/capacity.ts\n--- a/src/capacity.ts\n+++ b/src/capacity.ts\n@@ -0,0 +1,1 @@\n+export const capacity = 100;\n';

export const CapacityWorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('READY'), workerId: z.string().min(1) }),
  z.object({ type: z.literal('STOPPED'), workerId: z.string().min(1) }),
  z.object({ message: z.string().min(1), type: z.literal('ERROR'), workerId: z.string().min(1) }),
]);

export type CapacityWorkerMessage = z.infer<typeof CapacityWorkerMessageSchema>;

export type CapacitySeed = Readonly<{
  organizationId: string;
  projectIds: readonly string[];
  runIds: readonly string[];
}>;
