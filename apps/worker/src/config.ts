import { z } from 'zod';

const WorkerConfigSchema = z.object({
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.string().min(1).default('info'),
  M1_ENABLED: z.enum(['true', 'false']).default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url(),
  RABBITMQ_URL: z.url(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  EMAIL_OUTBOX_KEK_BASE64: z.string().min(1).optional(),
  EMAIL_OUTBOX_KEK_VERSION: z.coerce.number().int().positive().optional(),
  EMAIL_PROVIDER_API_KEY: z.string().min(1).optional(),
  EMAIL_PROVIDER_URL: z.url().optional(),
  GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
  GITHUB_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  WEB_ORIGIN: z.url().optional(),
  WORKER_HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
});

export type WorkerConfig = Readonly<{
  databaseUrl: string;
  healthHost: string;
  healthPort: number;
  logLevel: string;
  m1?: Readonly<{
    deepSeekApiKey: string;
    detailsBaseUrl: string;
    emailOutboxKey: Readonly<{ key: Buffer; version: number }>;
    emailProviderApiKey: string;
    emailProviderUrl: string;
    githubAppId: string;
    githubPrivateKeyPem: string;
    objectStorage: Readonly<{
      accessKeyId: string;
      bucket: string;
      endpoint: string;
      region: string;
      secretAccessKey: string;
    }>;
  }>;
  otelEndpoint: string;
  rabbitMqUrl: string;
}>;

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const config = WorkerConfigSchema.parse(environment);
  const m1 =
    config.M1_ENABLED === 'false'
      ? undefined
      : {
          deepSeekApiKey: requireM1Value(config.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY'),
          detailsBaseUrl: requireM1Value(config.WEB_ORIGIN, 'WEB_ORIGIN'),
          emailOutboxKey: {
            key: decodeKey(config.EMAIL_OUTBOX_KEK_BASE64, 'EMAIL_OUTBOX_KEK_BASE64'),
            version: requireM1Number(config.EMAIL_OUTBOX_KEK_VERSION, 'EMAIL_OUTBOX_KEK_VERSION'),
          },
          emailProviderApiKey: requireM1Value(
            config.EMAIL_PROVIDER_API_KEY,
            'EMAIL_PROVIDER_API_KEY',
          ),
          emailProviderUrl: requireM1Value(config.EMAIL_PROVIDER_URL, 'EMAIL_PROVIDER_URL'),
          githubAppId: requireM1Value(config.GITHUB_APP_ID, 'GITHUB_APP_ID'),
          githubPrivateKeyPem: Buffer.from(
            requireM1Value(config.GITHUB_PRIVATE_KEY_BASE64, 'GITHUB_PRIVATE_KEY_BASE64'),
            'base64',
          ).toString('utf8'),
          objectStorage: {
            accessKeyId: requireM1Value(config.S3_ACCESS_KEY, 'S3_ACCESS_KEY'),
            bucket: requireM1Value(config.S3_BUCKET, 'S3_BUCKET'),
            endpoint: requireM1Value(config.S3_ENDPOINT, 'S3_ENDPOINT'),
            region: requireM1Value(config.S3_REGION, 'S3_REGION'),
            secretAccessKey: requireM1Value(config.S3_SECRET_KEY, 'S3_SECRET_KEY'),
          },
        };
  return {
    databaseUrl: config.DATABASE_URL,
    healthHost: config.WORKER_HEALTH_HOST,
    healthPort: config.WORKER_HEALTH_PORT,
    logLevel: config.LOG_LEVEL,
    ...(m1 === undefined ? {} : { m1 }),
    otelEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    rabbitMqUrl: config.RABBITMQ_URL,
  };
}

function requireM1Value(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name}_REQUIRED_WHEN_M1_ENABLED`);
  return value;
}

function requireM1Number(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`${name}_REQUIRED_WHEN_M1_ENABLED`);
  return value;
}

function decodeKey(value: string | undefined, name: string): Buffer {
  const key = Buffer.from(requireM1Value(value, name), 'base64');
  if (key.byteLength !== 32) throw new Error(`${name}_MUST_DECODE_TO_32_BYTES`);
  return key;
}
