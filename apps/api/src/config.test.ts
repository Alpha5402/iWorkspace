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

  it('decodes every M1 security value only when explicitly enabled', () => {
    const accessPrivateKey = 'access private pem';
    const accessPublicKey = 'access public pem';
    const refreshPrivateKey = 'refresh private pem';
    const refreshPublicKey = 'refresh public pem';
    const githubKey = 'github pem';
    const config = loadApiConfig({
      ...validEnvironment,
      AUTH_ACCESS_KEY_ID: 'access-v1',
      AUTH_ACCESS_PREVIOUS_KEY_ID: 'access-v0',
      AUTH_ACCESS_PREVIOUS_PUBLIC_KEY_BASE64:
        Buffer.from('old access public pem').toString('base64'),
      AUTH_ACCESS_PRIVATE_KEY_BASE64: Buffer.from(accessPrivateKey).toString('base64'),
      AUTH_ACCESS_PUBLIC_KEY_BASE64: Buffer.from(accessPublicKey).toString('base64'),
      AUTH_REFRESH_KEY_ID: 'refresh-v1',
      AUTH_REFRESH_PRIVATE_KEY_BASE64: Buffer.from(refreshPrivateKey).toString('base64'),
      AUTH_REFRESH_PUBLIC_KEY_BASE64: Buffer.from(refreshPublicKey).toString('base64'),
      EMAIL_OUTBOX_KEK_BASE64: Buffer.alloc(32, 8).toString('base64'),
      EMAIL_OUTBOX_KEK_VERSION: '2',
      GITHUB_APP_ID: '123',
      GITHUB_APP_SLUG: 'iworkspace',
      GITHUB_PRIVATE_KEY_BASE64: Buffer.from(githubKey).toString('base64'),
      GITHUB_WEBHOOK_SECRET: 'github-webhook-secret',
      M1_ENABLED: 'true',
      SECRET_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
      TOKEN_PEPPER: 'token-pepper-with-at-least-thirty-two-characters',
      WEB_ORIGIN: 'https://web.example.test',
    });
    expect(config.m1).toMatchObject({
      authAccessKeys: {
        current: {
          keyId: 'access-v1',
          privateKeyPem: accessPrivateKey,
          publicKeyPem: accessPublicKey,
        },
        verificationKeys: [
          { keyId: 'access-v1', publicKeyPem: accessPublicKey },
          { keyId: 'access-v0', publicKeyPem: 'old access public pem' },
        ],
      },
      authRefreshKeys: {
        current: {
          keyId: 'refresh-v1',
          privateKeyPem: refreshPrivateKey,
          publicKeyPem: refreshPublicKey,
        },
        verificationKeys: [{ keyId: 'refresh-v1', publicKeyPem: refreshPublicKey }],
      },
      emailOutboxKey: { key: Buffer.alloc(32, 8), version: 2 },
      githubAppId: '123',
      githubPrivateKeyPem: githubKey,
      secretKeyEncryptionKey: Buffer.alloc(32, 7),
    });
  });

  it('fails closed for missing M1 values and invalid envelope keys', () => {
    expect(() => loadApiConfig({ ...validEnvironment, M1_ENABLED: 'true' })).toThrow(
      'AUTH_ACCESS_KEY_ID_REQUIRED_WHEN_M1_ENABLED',
    );
    expect(() =>
      loadApiConfig({
        ...validEnvironment,
        AUTH_ACCESS_KEY_ID: 'access-v1',
        AUTH_ACCESS_PRIVATE_KEY_BASE64: 'cHJpdmF0ZQ==',
        AUTH_ACCESS_PUBLIC_KEY_BASE64: 'cHVibGlj',
        AUTH_REFRESH_KEY_ID: 'refresh-v1',
        AUTH_REFRESH_PRIVATE_KEY_BASE64: 'cHJpdmF0ZQ==',
        AUTH_REFRESH_PUBLIC_KEY_BASE64: 'cHVibGlj',
        EMAIL_OUTBOX_KEK_BASE64: Buffer.alloc(32).toString('base64'),
        EMAIL_OUTBOX_KEK_VERSION: '1',
        GITHUB_APP_ID: '123',
        GITHUB_APP_SLUG: 'app',
        GITHUB_PRIVATE_KEY_BASE64: 'a2V5',
        GITHUB_WEBHOOK_SECRET: 'github-webhook-secret',
        M1_ENABLED: 'true',
        SECRET_KEK_BASE64: Buffer.alloc(16).toString('base64'),
        TOKEN_PEPPER: 'token-pepper-with-at-least-thirty-two-characters',
        WEB_ORIGIN: 'https://web.example.test',
      }),
    ).toThrow('SECRET_KEK_BASE64_MUST_DECODE_TO_32_BYTES');
  });

  it('requires complete and distinct previous-key rotation windows', () => {
    const m1Environment = {
      ...validEnvironment,
      AUTH_ACCESS_KEY_ID: 'access-v1',
      AUTH_ACCESS_PRIVATE_KEY_BASE64: 'cHJpdmF0ZQ==',
      AUTH_ACCESS_PUBLIC_KEY_BASE64: 'cHVibGlj',
      AUTH_REFRESH_KEY_ID: 'refresh-v1',
      AUTH_REFRESH_PRIVATE_KEY_BASE64: 'cHJpdmF0ZQ==',
      AUTH_REFRESH_PUBLIC_KEY_BASE64: 'cHVibGlj',
      EMAIL_OUTBOX_KEK_BASE64: Buffer.alloc(32).toString('base64'),
      EMAIL_OUTBOX_KEK_VERSION: '1',
      GITHUB_APP_ID: '123',
      GITHUB_APP_SLUG: 'app',
      GITHUB_PRIVATE_KEY_BASE64: 'a2V5',
      GITHUB_WEBHOOK_SECRET: 'github-webhook-secret',
      M1_ENABLED: 'true',
      SECRET_KEK_BASE64: Buffer.alloc(32).toString('base64'),
      TOKEN_PEPPER: 'token-pepper-with-at-least-thirty-two-characters',
      WEB_ORIGIN: 'https://web.example.test',
    };
    expect(() =>
      loadApiConfig({ ...m1Environment, AUTH_ACCESS_PREVIOUS_KEY_ID: 'access-v0' }),
    ).toThrow('AUTH_ACCESS_PREVIOUS_KEY_PAIR_INCOMPLETE');
    expect(() =>
      loadApiConfig({
        ...m1Environment,
        AUTH_REFRESH_PREVIOUS_KEY_ID: 'refresh-v1',
        AUTH_REFRESH_PREVIOUS_PUBLIC_KEY_BASE64: 'cHVibGlj',
      }),
    ).toThrow('AUTH_REFRESH_PREVIOUS_KEY_ID_MUST_DIFFER');
  });
});
