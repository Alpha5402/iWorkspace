import { z } from 'zod';

const ApiConfigSchema = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.string().min(1).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url(),
  OTEL_SERVICE_NAME: z.string().min(1).default('delivery-api'),
  RABBITMQ_URL: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
});

export type ApiConfig = Readonly<{
  databaseUrl: string;
  host: string;
  logLevel: string;
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

  return {
    databaseUrl: config.DATABASE_URL,
    host: config.API_HOST,
    logLevel: config.LOG_LEVEL,
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
