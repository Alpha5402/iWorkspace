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
    const privateKey = 'private pem';
    const publicKey = 'public pem';
    const githubKey = 'github pem';
    const config = loadApiConfig({
      ...validEnvironment,
      AUTH_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
      AUTH_PUBLIC_KEY_BASE64: Buffer.from(publicKey).toString('base64'),
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
      authPrivateKeyPem: privateKey,
      authPublicKeyPem: publicKey,
      githubAppId: '123',
      githubPrivateKeyPem: githubKey,
      secretKeyEncryptionKey: Buffer.alloc(32, 7),
    });
  });

  it('fails closed for missing M1 values and invalid envelope keys', () => {
    expect(() => loadApiConfig({ ...validEnvironment, M1_ENABLED: 'true' })).toThrow(
      'AUTH_PRIVATE_KEY_BASE64_REQUIRED_WHEN_M1_ENABLED',
    );
    expect(() =>
      loadApiConfig({
        ...validEnvironment,
        AUTH_PRIVATE_KEY_BASE64: 'cHJpdmF0ZQ==',
        AUTH_PUBLIC_KEY_BASE64: 'cHVibGlj',
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
});
