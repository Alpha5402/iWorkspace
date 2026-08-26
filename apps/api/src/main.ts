import { createPostgresProbe } from '@delivery/database';
import { createReadinessProbe } from '@delivery/health';
import { createRabbitMqProbe } from '@delivery/messaging';
import { createObjectStorageProbe } from '@delivery/object-storage';
import { createLogger, startTelemetry } from '@delivery/observability';

import { createApp } from './app.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig(process.env);
const logger = createLogger(config.serviceName, config.logLevel);
const telemetry = startTelemetry(config.serviceName, config.otelEndpoint);
const readinessProbe = createReadinessProbe([
  createPostgresProbe(config.databaseUrl),
  createRabbitMqProbe(config.rabbitMqUrl),
  createObjectStorageProbe(config.objectStorage),
]);
const app = createApp({ logger, readinessProbe, serviceName: config.serviceName });
const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'api listening');
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'api shutting down');
  server.close();
  await readinessProbe.close();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
