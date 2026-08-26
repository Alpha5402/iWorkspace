import { z } from 'zod';

export const PlannedPhaseSchema = z.enum(['M1', 'M2', 'M3']);

export const RunStatusSchema = z.enum([
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'SUCCEEDED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'STALE',
  'REJECTED',
]);

export const CapabilityDefinitionSchema = z.object({
  id: z.string().min(1),
  path: z.string().startsWith('/'),
  plannedPhase: PlannedPhaseSchema,
});

export const ErrorResponseSchema = z.object({
  error: z.object({
    capability: z.string().min(1).optional(),
    code: z.string().min(1),
    message: z.string().min(1),
    plannedPhase: PlannedPhaseSchema.optional(),
    traceId: z.string().min(1),
  }),
});

export const HealthResponseSchema = z.object({
  dependencies: z
    .record(
      z.string(),
      z.object({
        status: z.enum(['up', 'down']),
      }),
    )
    .optional(),
  service: z.string().min(1),
  status: z.enum(['ok', 'degraded']),
  traceId: z.string().min(1).optional(),
});

export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const capabilities = [
  { id: 'identity', path: '/identity', plannedPhase: 'M1' },
  { id: 'project', path: '/projects', plannedPhase: 'M1' },
  { id: 'artifact', path: '/artifacts', plannedPhase: 'M1' },
  { id: 'workflow', path: '/runs', plannedPhase: 'M1' },
  { id: 'review', path: '/reviews', plannedPhase: 'M1' },
  { id: 'integration', path: '/integrations', plannedPhase: 'M1' },
  { id: 'audit', path: '/audit', plannedPhase: 'M1' },
  { id: 'design', path: '/designs', plannedPhase: 'M2' },
  { id: 'delivery', path: '/deliveries', plannedPhase: 'M3' },
] as const satisfies readonly CapabilityDefinition[];

type OpenApiDocument = Readonly<{
  components: Readonly<{ schemas: Readonly<Record<string, unknown>> }>;
  info: Readonly<{ title: string; version: string }>;
  openapi: '3.1.0';
  paths: Readonly<Record<string, unknown>>;
}>;

export function createOpenApiDocument(): OpenApiDocument {
  const notImplementedResponse = {
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
      },
    },
    description: 'Capability is planned but not implemented in M0.',
  };

  const paths = Object.fromEntries(
    capabilities.map((capability) => [
      `/api/v1${capability.path}`,
      {
        get: {
          operationId: `${capability.id}Placeholder`,
          responses: { 501: notImplementedResponse },
          summary: `${capability.id} capability placeholder (${capability.plannedPhase})`,
          tags: [capability.id],
        },
      },
    ]),
  );

  return {
    components: {
      schemas: {
        ErrorResponse: z.toJSONSchema(ErrorResponseSchema),
        HealthResponse: z.toJSONSchema(HealthResponseSchema),
        RunStatus: z.toJSONSchema(RunStatusSchema),
      },
    },
    info: {
      title: 'AI Delivery Control Plane API',
      version: '0.0.0-m0',
    },
    openapi: '3.1.0',
    paths,
  };
}
