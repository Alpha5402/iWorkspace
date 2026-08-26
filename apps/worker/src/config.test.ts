import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from './config.js';

describe('Worker configuration', () => {
  it('validates and maps worker dependencies', () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL: 'postgresql://delivery:test@127.0.0.1:5432/delivery',
        LOG_LEVEL: 'silent',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        RABBITMQ_URL: 'amqp://delivery:test@127.0.0.1:5672',
        WORKER_HEALTH_HOST: '127.0.0.1',
        WORKER_HEALTH_PORT: '3101',
      }),
    ).toEqual({
      databaseUrl: 'postgresql://delivery:test@127.0.0.1:5432/delivery',
      healthHost: '127.0.0.1',
      healthPort: 3101,
      logLevel: 'silent',
      otelEndpoint: 'http://127.0.0.1:4318',
      rabbitMqUrl: 'amqp://delivery:test@127.0.0.1:5672',
    });
  });

  it('fails without durable dependencies', () => {
    expect(() => loadWorkerConfig({})).toThrow();
  });
});
