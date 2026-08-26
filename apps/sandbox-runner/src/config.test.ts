import { describe, expect, it } from 'vitest';

import { loadSandboxConfig } from './config.js';

describe('Sandbox Runner configuration', () => {
  it('validates health and telemetry settings', () => {
    expect(
      loadSandboxConfig({
        LOG_LEVEL: 'silent',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        SANDBOX_HEALTH_HOST: '127.0.0.1',
        SANDBOX_HEALTH_PORT: '3102',
      }),
    ).toEqual({
      healthHost: '127.0.0.1',
      healthPort: 3102,
      logLevel: 'silent',
      otelEndpoint: 'http://127.0.0.1:4318',
    });
  });

  it('fails without telemetry configuration', () => {
    expect(() => loadSandboxConfig({})).toThrow();
  });
});
