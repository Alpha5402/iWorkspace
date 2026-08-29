import { z } from 'zod';

const ApiConfigSchema = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.string().min(1).default('info'),
  M1_ENABLED: z.enum(['true', 'false']).default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url(),
  OTEL_SERVICE_NAME: z.string().min(1).default('delivery-api'),
  RABBITMQ_URL: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  AUTH_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  AUTH_PUBLIC_KEY_BASE64: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
  GITHUB_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),
  TOKEN_PEPPER: z.string().min(32).optional(),
  SECRET_KEK_BASE64: z.string().min(1).optional(),
  WEB_ORIGIN: z.url().optional(),
});

export type ApiConfig = Readonly<{
  databaseUrl: string;
  host: string;
  logLevel: string;
  m1?: Readonly<{
    authPrivateKeyPem: string;
    authPublicKeyPem: string;
    githubAppSlug: string;
    githubAppId: string;
    githubPrivateKeyPem: string;
    githubWebhookSecret: string;
    tokenPepper: string;
    secretKeyEncryptionKey: Buffer;
    webOrigin: string;
  }>;
  objectStorage: Readonly<{
    accessKeyId: string;
    bucket: string;
    endpoint: string;
    region: string;
    secretAccessKey: string;
  }>;
  otelEndpoint: string;
  port: number;
  rabbitMqUrl: string;
  serviceName: string;
}>;

export function loadApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const config = ApiConfigSchema.parse(environment);

  const m1 =
    config.M1_ENABLED === 'false'
      ? undefined
      : {
          authPrivateKeyPem: decodePem(config.AUTH_PRIVATE_KEY_BASE64, 'AUTH_PRIVATE_KEY_BASE64'),
          authPublicKeyPem: decodePem(config.AUTH_PUBLIC_KEY_BASE64, 'AUTH_PUBLIC_KEY_BASE64'),
          githubAppSlug: requireM1Value(config.GITHUB_APP_SLUG, 'GITHUB_APP_SLUG'),
          githubAppId: requireM1Value(config.GITHUB_APP_ID, 'GITHUB_APP_ID'),
          githubPrivateKeyPem: decodePem(
            config.GITHUB_PRIVATE_KEY_BASE64,
            'GITHUB_PRIVATE_KEY_BASE64',
          ),
          githubWebhookSecret: requireM1Value(
            config.GITHUB_WEBHOOK_SECRET,
            'GITHUB_WEBHOOK_SECRET',
          ),
          tokenPepper: requireM1Value(config.TOKEN_PEPPER, 'TOKEN_PEPPER'),
          secretKeyEncryptionKey: decodeKey(config.SECRET_KEK_BASE64, 'SECRET_KEK_BASE64'),
          webOrigin: requireM1Value(config.WEB_ORIGIN, 'WEB_ORIGIN'),
        };

  return {
    databaseUrl: config.DATABASE_URL,
    host: config.API_HOST,
    logLevel: config.LOG_LEVEL,
    ...(m1 === undefined ? {} : { m1 }),
    objectStorage: {
      accessKeyId: config.S3_ACCESS_KEY,
      bucket: config.S3_BUCKET,
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    otelEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    port: config.API_PORT,
    rabbitMqUrl: config.RABBITMQ_URL,
    serviceName: config.OTEL_SERVICE_NAME,
  };
}

function requireM1Value(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name}_REQUIRED_WHEN_M1_ENABLED`);
  return value;
}

function decodePem(value: string | undefined, name: string): string {
  return Buffer.from(requireM1Value(value, name), 'base64').toString('utf8');
}

function decodeKey(value: string | undefined, name: string): Buffer {
  const key = Buffer.from(requireM1Value(value, name), 'base64');
  if (key.byteLength !== 32) throw new Error(`${name}_MUST_DECODE_TO_32_BYTES`);
  return key;
}
