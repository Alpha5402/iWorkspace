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
  AUTH_ACCESS_KEY_ID: z.string().min(1).optional(),
  AUTH_ACCESS_PREVIOUS_KEY_ID: z.string().min(1).optional(),
  AUTH_ACCESS_PREVIOUS_PUBLIC_KEY_BASE64: z.string().min(1).optional(),
  AUTH_ACCESS_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  AUTH_ACCESS_PUBLIC_KEY_BASE64: z.string().min(1).optional(),
  AUTH_REFRESH_KEY_ID: z.string().min(1).optional(),
  AUTH_REFRESH_PREVIOUS_KEY_ID: z.string().min(1).optional(),
  AUTH_REFRESH_PREVIOUS_PUBLIC_KEY_BASE64: z.string().min(1).optional(),
  AUTH_REFRESH_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  AUTH_REFRESH_PUBLIC_KEY_BASE64: z.string().min(1).optional(),
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
    authAccessKeys: ConfiguredJwtKeySet;
    authRefreshKeys: ConfiguredJwtKeySet;
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
          authAccessKeys: loadJwtKeySet({
            currentKeyId: config.AUTH_ACCESS_KEY_ID,
            currentPrivateKeyBase64: config.AUTH_ACCESS_PRIVATE_KEY_BASE64,
            currentPublicKeyBase64: config.AUTH_ACCESS_PUBLIC_KEY_BASE64,
            name: 'AUTH_ACCESS',
            previousKeyId: config.AUTH_ACCESS_PREVIOUS_KEY_ID,
            previousPublicKeyBase64: config.AUTH_ACCESS_PREVIOUS_PUBLIC_KEY_BASE64,
          }),
          authRefreshKeys: loadJwtKeySet({
            currentKeyId: config.AUTH_REFRESH_KEY_ID,
            currentPrivateKeyBase64: config.AUTH_REFRESH_PRIVATE_KEY_BASE64,
            currentPublicKeyBase64: config.AUTH_REFRESH_PUBLIC_KEY_BASE64,
            name: 'AUTH_REFRESH',
            previousKeyId: config.AUTH_REFRESH_PREVIOUS_KEY_ID,
            previousPublicKeyBase64: config.AUTH_REFRESH_PREVIOUS_PUBLIC_KEY_BASE64,
          }),
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

type ConfiguredJwtKeySet = Readonly<{
  current: Readonly<{ keyId: string; privateKeyPem: string; publicKeyPem: string }>;
  verificationKeys: readonly Readonly<{ keyId: string; publicKeyPem: string }>[];
}>;

function loadJwtKeySet(
  input: Readonly<{
    currentKeyId?: string | undefined;
    currentPrivateKeyBase64?: string | undefined;
    currentPublicKeyBase64?: string | undefined;
    name: 'AUTH_ACCESS' | 'AUTH_REFRESH';
    previousKeyId?: string | undefined;
    previousPublicKeyBase64?: string | undefined;
  }>,
): ConfiguredJwtKeySet {
  const currentKeyId = requireM1Value(input.currentKeyId, `${input.name}_KEY_ID`);
  const current = {
    keyId: currentKeyId,
    privateKeyPem: decodePem(input.currentPrivateKeyBase64, `${input.name}_PRIVATE_KEY_BASE64`),
    publicKeyPem: decodePem(input.currentPublicKeyBase64, `${input.name}_PUBLIC_KEY_BASE64`),
  };
  const hasPreviousKeyId = input.previousKeyId !== undefined;
  const hasPreviousPublicKey = input.previousPublicKeyBase64 !== undefined;
  if (hasPreviousKeyId !== hasPreviousPublicKey) {
    throw new Error(`${input.name}_PREVIOUS_KEY_PAIR_INCOMPLETE`);
  }
  if (!hasPreviousKeyId) {
    return { current, verificationKeys: [current] };
  }
  if (input.previousKeyId === currentKeyId) {
    throw new Error(`${input.name}_PREVIOUS_KEY_ID_MUST_DIFFER`);
  }
  return {
    current,
    verificationKeys: [
      current,
      {
        keyId: input.previousKeyId,
        publicKeyPem: decodePem(
          input.previousPublicKeyBase64,
          `${input.name}_PREVIOUS_PUBLIC_KEY_BASE64`,
        ),
      },
    ],
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
