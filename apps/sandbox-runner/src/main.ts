import { createProcessHealthServer, createReadinessProbe } from '@delivery/health';
import { createLogger, startServerSpan, startTelemetry } from '@delivery/observability';
import Docker from 'dockerode';

import { loadSandboxConfig } from './config.js';
import { createDockerProbe } from './dockerProbe.js';

const serviceName = 'delivery-sandbox-runner';
const config = loadSandboxConfig(process.env);
const logger = createLogger(serviceName, config.logLevel);
const telemetry = startTelemetry(serviceName, config.otelEndpoint);
const readinessProbe = createReadinessProbe([createDockerProbe(new Docker())]);
const healthServer = createProcessHealthServer({
  host: config.healthHost,
  port: config.healthPort,
  readinessProbe,
  service: serviceName,
  startSpan: (name, headers) => startServerSpan(serviceName, name, headers),
});

healthServer.listen(config.healthPort, config.healthHost, () => {
  logger.info(
    { host: config.healthHost, mode: 'm0-no-execution', port: config.healthPort },
    'sandbox runner health server listening',
  );
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'sandbox runner shutting down');
  healthServer.close();
  await readinessProbe.close();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
