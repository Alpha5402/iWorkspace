import { z } from 'zod';

const WorkerConfigSchema = z.object({
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.string().min(1).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url(),
  RABBITMQ_URL: z.url(),
  WORKER_HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
});

export type WorkerConfig = Readonly<{
  databaseUrl: string;
  healthHost: string;
  healthPort: number;
  logLevel: string;
  otelEndpoint: string;
  rabbitMqUrl: string;
}>;

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const config = WorkerConfigSchema.parse(environment);
  return {
    databaseUrl: config.DATABASE_URL,
    healthHost: config.WORKER_HEALTH_HOST,
    healthPort: config.WORKER_HEALTH_PORT,
    logLevel: config.LOG_LEVEL,
    otelEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    rabbitMqUrl: config.RABBITMQ_URL,
  };
}
