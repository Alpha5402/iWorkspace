import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from './config.js';

describe('Worker configuration', () => {
  const infrastructure = {
    DATABASE_URL: 'postgresql://delivery:test@127.0.0.1:5432/delivery',
    LOG_LEVEL: 'silent',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    RABBITMQ_URL: 'amqp://delivery:test@127.0.0.1:5672',
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: '3101',
  };

  it('validates and maps worker dependencies', () => {
    expect(loadWorkerConfig(infrastructure)).toEqual({
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

  it('maps all explicit M1 worker dependencies and decodes the GitHub key', () => {
    expect(
      loadWorkerConfig({
        ...infrastructure,
        DEEPSEEK_API_KEY: 'deepseek-key',
        EMAIL_OUTBOX_KEK_BASE64: Buffer.alloc(32, 8).toString('base64'),
        EMAIL_OUTBOX_KEK_VERSION: '2',
        EMAIL_PROVIDER_API_KEY: 'email-key',
        EMAIL_PROVIDER_URL: 'https://email.example.test/send',
        GITHUB_APP_ID: '123',
        GITHUB_PRIVATE_KEY_BASE64: Buffer.from('github pem').toString('base64'),
        M1_ENABLED: 'true',
        S3_ACCESS_KEY: 'access',
        S3_BUCKET: 'artifacts',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        S3_REGION: 'us-east-1',
        S3_SECRET_KEY: 'secret',
        WEB_ORIGIN: 'https://web.example.test',
      }).m1,
    ).toEqual({
      artifactGarbageCollection: {
        intervalMilliseconds: 900_000,
        maximumObjectsPerSweep: 5_000,
        minimumAgeMilliseconds: 86_400_000,
      },
      deepSeekApiKey: 'deepseek-key',
      detailsBaseUrl: 'https://web.example.test',
      emailOutboxKey: { key: Buffer.alloc(32, 8), version: 2 },
      emailProviderApiKey: 'email-key',
      emailProviderUrl: 'https://email.example.test/send',
      githubAppId: '123',
      githubPrivateKeyPem: 'github pem',
      objectStorage: {
        accessKeyId: 'access',
        bucket: 'artifacts',
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        secretAccessKey: 'secret',
      },
    });
  });

  it('requires each M1-only value when enabled', () => {
    expect(() => loadWorkerConfig({ ...infrastructure, M1_ENABLED: 'true' })).toThrow(
      'DEEPSEEK_API_KEY_REQUIRED_WHEN_M1_ENABLED',
    );
  });
});
