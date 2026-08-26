import { describe, expect, it } from 'vitest';

import { loadApiConfig } from './config.js';

const validEnvironment: NodeJS.ProcessEnv = {
  API_HOST: '127.0.0.1',
  API_PORT: '3100',
  DATABASE_URL: 'postgresql://delivery:test@127.0.0.1:5432/delivery',
  LOG_LEVEL: 'silent',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  OTEL_SERVICE_NAME: 'test-api',
  RABBITMQ_URL: 'amqp://delivery:test@127.0.0.1:5672',
  S3_ACCESS_KEY: 'delivery',
  S3_BUCKET: 'artifacts',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_SECRET_KEY: 'test-secret',
};

describe('API configuration', () => {
  it('maps validated environment values into an immutable shape', () => {
    expect(loadApiConfig(validEnvironment)).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      host: '127.0.0.1',
      logLevel: 'silent',
      objectStorage: {
        accessKeyId: 'delivery',
        bucket: 'artifacts',
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        secretAccessKey: 'test-secret',
      },
      otelEndpoint: 'http://127.0.0.1:4318',
      port: 3100,
      rabbitMqUrl: validEnvironment.RABBITMQ_URL,
      serviceName: 'test-api',
    });
  });

  it('fails fast when required infrastructure configuration is absent', () => {
    expect(() => loadApiConfig({})).toThrow();
  });
});
