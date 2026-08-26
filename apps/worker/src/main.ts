import { createPostgresProbe } from '@delivery/database';
import { createProcessHealthServer, createReadinessProbe } from '@delivery/health';
import { createRabbitMqProbe } from '@delivery/messaging';
import { createLogger, startServerSpan, startTelemetry } from '@delivery/observability';

import { loadWorkerConfig } from './config.js';

const serviceName = 'delivery-worker';
const config = loadWorkerConfig(process.env);
const logger = createLogger(serviceName, config.logLevel);
const telemetry = startTelemetry(serviceName, config.otelEndpoint);
const readinessProbe = createReadinessProbe([
  createPostgresProbe(config.databaseUrl),
  createRabbitMqProbe(config.rabbitMqUrl),
]);
const healthServer = createProcessHealthServer({
  host: config.healthHost,
  port: config.healthPort,
  readinessProbe,
  service: serviceName,
  startSpan: (name, headers) => startServerSpan(serviceName, name, headers),
});

healthServer.listen(config.healthPort, config.healthHost, () => {
  logger.info(
    { host: config.healthHost, mode: 'm0-idle', port: config.healthPort },
    'worker health server listening',
  );
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  healthServer.close();
  await readinessProbe.close();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
