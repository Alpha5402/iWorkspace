import { describe, expect, it } from 'vitest';

import {
  capabilities,
  createOpenApiDocument,
  ErrorResponseSchema,
  HealthResponseSchema,
  RunStatusSchema,
} from './index.js';

describe('contracts', () => {
  it('keeps capability paths unique and phase-bound', () => {
    const paths = capabilities.map(({ path }) => path);

    expect(new Set(paths).size).toBe(paths.length);
    expect(capabilities).toContainEqual({
      id: 'design',
      path: '/designs',
      plannedPhase: 'M2',
    });
  });

  it('generates OpenAPI paths from the same capability registry', () => {
    const document = createOpenApiDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toHaveLength(capabilities.length);
    expect(document.paths).toHaveProperty('/api/v1/reviews');
    expect(document.components.schemas).toHaveProperty('RunStatus');
  });

  it('freezes the M1 Run status contract', () => {
    expect(RunStatusSchema.parse('PARTIAL')).toBe('PARTIAL');
    expect(() => RunStatusSchema.parse('DONE')).toThrow();
  });

  it('publishes the ruleset draft lifecycle in the M1 OpenAPI contract', () => {
    const paths = createOpenApiDocument(true).paths;

    expect(paths).toHaveProperty('/api/v1/projects/{projectId}/rulesets/{rulesetId}/versions');
    expect(paths).toHaveProperty('/api/v1/projects/{projectId}/ruleset-versions/{versionId}');
    expect(paths).toHaveProperty(
      '/api/v1/projects/{projectId}/ruleset-versions/{versionId}/publish',
    );
  });

  it('publishes administrator invitation lifecycle endpoints', () => {
    const paths = createOpenApiDocument(true).paths;

    expect(paths).toHaveProperty('/api/v1/admin/administrator-invitations');
    expect(paths).toHaveProperty('/api/v1/admin/administrator-invitations/{invitationId}/resend');
    expect(paths).toHaveProperty('/api/v1/auth/administrator-invitations/accept');
  });

  it('rejects malformed error and health responses', () => {
    expect(() => ErrorResponseSchema.parse({ error: { code: '', traceId: '' } })).toThrow();
    expect(() => HealthResponseSchema.parse({ service: '', status: 'unknown' })).toThrow();
  });
});
