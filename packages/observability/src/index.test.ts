import { describe, expect, it } from 'vitest';

import { createLogger, getTracer, startServerSpan, startTelemetry } from './index.js';

describe('observability', () => {
  it('creates a service-bound logger and tracer', () => {
    const logger = createLogger('test-service', 'silent');

    expect(logger.bindings()).toMatchObject({ service: 'test-service' });
    expect(getTracer('test-service')).toBeDefined();
  });

  it('creates a server span handle for inbound request propagation', () => {
    const span = startServerSpan('test-service', 'GET /health/live', {});

    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(() => {
      span.end(200);
    }).not.toThrow();
  });

  it('starts and shuts down an OpenTelemetry SDK without exporting secrets', async () => {
    const telemetry = startTelemetry('test-service', 'http://127.0.0.1:4318/');

    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});
