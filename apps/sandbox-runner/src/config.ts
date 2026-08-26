import { z } from 'zod';

const SandboxConfigSchema = z.object({
  LOG_LEVEL: z.string().min(1).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url(),
  SANDBOX_HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
  SANDBOX_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
});

export type SandboxConfig = Readonly<{
  healthHost: string;
  healthPort: number;
  logLevel: string;
  otelEndpoint: string;
}>;

export function loadSandboxConfig(environment: NodeJS.ProcessEnv): SandboxConfig {
  const config = SandboxConfigSchema.parse(environment);
  return {
    healthHost: config.SANDBOX_HEALTH_HOST,
    healthPort: config.SANDBOX_HEALTH_PORT,
    logLevel: config.LOG_LEVEL,
    otelEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}
