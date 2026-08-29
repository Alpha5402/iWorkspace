import { z } from 'zod';

export const PlannedPhaseSchema = z.enum(['M1', 'M2', 'M3']);

export const RunStatusSchema = z.enum([
  'ACCEPTED',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
  'STALE',
]);

export const ProjectTokenScopeSchema = z.enum([
  'review:trigger',
  'review:read',
  'project:read',
  'artifact:read',
]);

export const RuleDefinitionSchema = z.object({
  appliesTo: z.object({
    languages: z.array(z.string().min(1)).default([]),
    paths: z.array(z.string().min(1)).default(['**/*']),
  }),
  category: z.enum(['DESIGN', 'IMPLEMENTATION', 'DEFECT']),
  defaultSeverity: z.enum(['BLOCKING', 'MAJOR', 'MINOR', 'INFO']),
  deterministicHandler: z.string().min(1).optional(),
  evidenceRequirement: z.string().min(1),
  guidance: z.string().min(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9/_.-]+$/),
  title: z.string().min(1).max(160),
});

export const ReviewTriggerSchema = z.object({
  rerunOfRunId: z.uuid().optional(),
  rulesetVersionId: z.uuid().optional(),
  source: z.object({
    pullRequestNumber: z.number().int().positive(),
    repositoryConnectionId: z.uuid(),
    type: z.literal('github_pull_request'),
  }),
});

export const FindingSchema = z.object({
  category: z.enum(['DESIGN', 'IMPLEMENTATION', 'DEFECT']),
  confidence: z.number().min(0).max(1),
  description: z.string().min(1),
  endLine: z.number().int().positive(),
  evidence: z.array(z.string()),
  fingerprint: z.string().min(1),
  path: z.string().min(1),
  ruleId: z.string().min(1),
  severity: z.enum(['BLOCKING', 'MAJOR', 'MINOR', 'INFO']),
  side: z.enum(['LEFT', 'RIGHT']),
  source: z.enum(['DETERMINISTIC', 'MODEL']),
  startLine: z.number().int().positive(),
  title: z.string().min(1),
  verificationStatus: z.enum(['CONFIRMED', 'DISPUTED', 'REJECTED', 'NEEDS_HUMAN']),
});

export const EventEnvelopeV1Schema = z.object({
  causationId: z.string().min(1).optional(),
  correlationId: z.string().min(1),
  eventId: z.uuid(),
  eventType: z.string().min(1),
  eventVersion: z.literal(1),
  occurredAt: z.iso.datetime(),
  organizationId: z.uuid(),
  payload: z.record(z.string(), z.unknown()),
  projectId: z.uuid(),
  traceparent: z.string().min(1).optional(),
});

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
export type EventEnvelopeV1 = z.infer<typeof EventEnvelopeV1Schema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ProjectTokenScope = z.infer<typeof ProjectTokenScopeSchema>;
export type ReviewTrigger = z.infer<typeof ReviewTriggerSchema>;
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

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

export function createOpenApiDocument(m1Enabled = false): OpenApiDocument {
  const notImplementedResponse = {
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
      },
    },
    description: 'Capability is planned but not implemented in M0.',
  };

  const placeholderCapabilities = capabilities.filter(
    (capability) => !m1Enabled || capability.plannedPhase !== 'M1',
  );
  const paths: Record<string, unknown> = Object.fromEntries(
    placeholderCapabilities.map((capability) => [
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
  if (m1Enabled) {
    Object.assign(paths, {
      '/api/v1/auth/register': {
        post: {
          operationId: 'registerAccount',
          responses: { 202: { description: 'Registration accepted' } },
          tags: ['identity'],
        },
      },
      '/api/v1/auth/resend-verification': {
        post: {
          operationId: 'resendEmailVerification',
          responses: { 202: { description: 'Verification request accepted' } },
          tags: ['identity'],
        },
      },
      '/api/v1/auth/verify-email': {
        post: {
          operationId: 'verifyEmail',
          responses: { 200: { description: 'Email verified' } },
          tags: ['identity'],
        },
      },
      '/api/v1/auth/login': {
        post: {
          operationId: 'login',
          responses: { 200: { description: 'Authenticated' } },
          tags: ['identity'],
        },
      },
      '/api/v1/auth/logout': {
        post: {
          operationId: 'logout',
          responses: { 204: { description: 'Logged out' } },
          tags: ['identity'],
        },
      },
      '/api/v1/auth/refresh': {
        post: {
          operationId: 'refreshSession',
          responses: { 200: { description: 'Rotated session' } },
          tags: ['identity'],
        },
      },
      '/api/v1/me': {
        get: {
          operationId: 'getCurrentActor',
          responses: { 200: { description: 'Current actor' } },
          tags: ['identity'],
        },
      },
      '/api/v1/projects': {
        get: {
          operationId: 'listProjects',
          responses: { 200: { description: 'Projects' } },
          tags: ['project'],
        },
        post: {
          operationId: 'createProject',
          responses: { 201: { description: 'Project created' } },
          tags: ['project'],
        },
      },
      '/api/v1/projects/{projectId}/reviews': {
        get: {
          operationId: 'listReviews',
          responses: { 200: { description: 'Review runs' } },
          tags: ['review'],
        },
        post: {
          operationId: 'triggerReview',
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ReviewTrigger' } },
            },
            required: true,
          },
          responses: { 202: { description: 'Review accepted' } },
          tags: ['review'],
        },
      },
      '/api/v1/reviews/{runId}': {
        get: {
          operationId: 'getReview',
          responses: { 200: { description: 'Review run' } },
          tags: ['review'],
        },
      },
      '/api/v1/reviews/{runId}/events': {
        get: {
          operationId: 'streamReviewEvents',
          responses: { 200: { description: 'SSE event stream' } },
          tags: ['review'],
        },
      },
      '/api/v1/reviews/{runId}/findings': {
        get: {
          operationId: 'listReviewFindings',
          responses: { 200: { description: 'Findings' } },
          tags: ['review'],
        },
      },
      '/api/v1/integrations/github/webhooks': {
        post: {
          operationId: 'receiveGitHubWebhook',
          responses: { 202: { description: 'Webhook accepted' } },
          tags: ['integration'],
        },
      },
    });
  }

  return {
    components: {
      schemas: {
        ErrorResponse: z.toJSONSchema(ErrorResponseSchema),
        Finding: z.toJSONSchema(FindingSchema),
        HealthResponse: z.toJSONSchema(HealthResponseSchema),
        RunStatus: z.toJSONSchema(RunStatusSchema),
        ReviewTrigger: z.toJSONSchema(ReviewTriggerSchema),
        RuleDefinition: z.toJSONSchema(RuleDefinitionSchema),
      },
    },
    info: {
      title: 'AI Delivery Control Plane API',
      version: '0.1.0-m1',
    },
    openapi: '3.1.0',
    paths,
  };
}
