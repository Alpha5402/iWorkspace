import { ErrorResponseSchema } from '@delivery/contracts';
import { createLogger } from '@delivery/observability';
import { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';

function createTestApp(ready = true): Express {
  return createApp({
    logger: createLogger('test-api', 'silent'),
    readinessProbe: {
      check: () =>
        Promise.resolve({
          dependencies: {
            postgres: { status: ready ? 'up' : 'down' },
          },
          ready,
        }),
      close: () => Promise.resolve(),
    },
    serviceName: 'test-api',
  });
}

describe('Express application', () => {
  it('serves liveness with security and correlation headers', async () => {
    const response = await request(createTestApp())
      .get('/health/live')
      .set('x-request-id', 'test-request');

    expect(response.status).toBe(200);
    expect(response.headers).not.toHaveProperty('x-powered-by');
    expect(response.headers['x-request-id']).toBe('test-request');
    expect(response.headers['x-trace-id']).toBeTypeOf('string');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toMatchObject({ service: 'test-api', status: 'ok' });
  });

  it('rejects an oversized request ID and creates a bounded one', async () => {
    const response = await request(createTestApp())
      .get('/health/live')
      .set('x-request-id', 'x'.repeat(129));

    expect(response.headers['x-request-id']).not.toBe('x'.repeat(129));
    expect(response.headers['x-request-id']).toHaveLength(36);
  });

  it('reports dependency readiness without leaking errors', async () => {
    const ready = await request(createTestApp()).get('/health/ready');
    const degraded = await request(createTestApp(false)).get('/health/ready');

    expect(ready.status).toBe(200);
    expect(degraded.status).toBe(503);
    expect(degraded.body).toMatchObject({
      dependencies: { postgres: { status: 'down' } },
      status: 'degraded',
    });
  });

  it('returns OpenAPI generated from the capability registry', async () => {
    const response = await request(createTestApp()).get('/api/v1/openapi.json');
    const openApi = z
      .object({ openapi: z.literal('3.1.0'), paths: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(response.text) as unknown);

    expect(response.status).toBe(200);
    expect(openApi.paths).toHaveProperty('/api/v1/reviews');
  });

  it('returns an honest 501 for planned capabilities', async () => {
    const response = await request(createTestApp()).post('/api/v1/designs/annotations');
    const body = ErrorResponseSchema.parse(JSON.parse(response.text) as unknown);

    expect(response.status).toBe(501);
    expect(body).toMatchObject({
      error: {
        capability: 'design',
        code: 'FEATURE_NOT_IMPLEMENTED',
        plannedPhase: 'M2',
      },
    });
  });

  it('returns a stable 404 without infrastructure details', async () => {
    const response = await request(createTestApp()).get('/unknown');
    const body = ErrorResponseSchema.parse(JSON.parse(response.text) as unknown);

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error).not.toHaveProperty('stack');
  });
});
