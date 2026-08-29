import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { createDatabase, createPostgresProbe } from '@delivery/database';
import { createProcessHealthServer, createReadinessProbe } from '@delivery/health';
import { createRabbitMqProbe, RabbitMqBus } from '@delivery/messaging';
import { createObjectStorageProbe, ImmutableArtifactStore } from '@delivery/object-storage';
import { createLogger, startServerSpan, startTelemetry } from '@delivery/observability';
import { DeepSeekResponsesProvider } from '@delivery/providers-agent';
import { HttpEmailProvider } from '@delivery/providers-email';
import { GitHubAppProvider } from '@delivery/providers-github';

import { loadWorkerConfig } from './config.js';
import {
  ArtifactGarbageCollector,
  createArtifactReferenceLookup,
} from './artifactGarbageCollector.js';
import { EmailDeliveryWorker } from './emailDeliveryWorker.js';
import { ReviewWorker } from './reviewWorker.js';

const serviceName = 'delivery-worker';
const config = loadWorkerConfig(process.env);
const logger = createLogger(serviceName, config.logLevel);
const telemetry = startTelemetry(serviceName, config.otelEndpoint);
const readinessDependencies = [
  createPostgresProbe(config.databaseUrl),
  createRabbitMqProbe(config.rabbitMqUrl),
] as const;
const readinessProbe = createReadinessProbe(
  config.m1 === undefined
    ? readinessDependencies
    : [...readinessDependencies, createObjectStorageProbe(config.m1.objectStorage)],
);
const healthServer = createProcessHealthServer({
  host: config.healthHost,
  port: config.healthPort,
  readinessProbe,
  service: serviceName,
  startSpan: (name, headers) => startServerSpan(serviceName, name, headers),
});

healthServer.listen(config.healthPort, config.healthHost, () => {
  logger.info(
    {
      host: config.healthHost,
      mode: config.m1 === undefined ? 'm1-disabled' : 'm1-review',
      port: config.healthPort,
    },
    'worker health server listening',
  );
});

const database = config.m1 === undefined ? undefined : createDatabase(config.databaseUrl);
const reviewWorker =
  config.m1 === undefined || database === undefined
    ? undefined
    : new ReviewWorker(
        database,
        await RabbitMqBus.connect(config.rabbitMqUrl),
        new GitHubAppProvider(config.m1.githubAppId, config.m1.githubPrivateKeyPem),
        new DeepSeekResponsesProvider(config.m1.deepSeekApiKey),
        new ImmutableArtifactStore(config.m1.objectStorage),
        config.m1.detailsBaseUrl,
        `${hostname()}:${process.pid}:${randomUUID()}`,
        logger,
      );
const emailWorker =
  config.m1 === undefined || database === undefined
    ? undefined
    : new EmailDeliveryWorker(
        database,
        new HttpEmailProvider(config.m1.emailProviderUrl, config.m1.emailProviderApiKey),
        new Map([[config.m1.emailOutboxKey.version, config.m1.emailOutboxKey.key]]),
        config.m1.detailsBaseUrl,
        `${hostname()}:${process.pid}:email:${randomUUID()}`,
        logger,
      );
const artifactGarbageCollectionStore =
  config.m1 === undefined || database === undefined
    ? undefined
    : new ImmutableArtifactStore(config.m1.objectStorage);
const artifactGarbageCollector =
  config.m1 === undefined || database === undefined || artifactGarbageCollectionStore === undefined
    ? undefined
    : new ArtifactGarbageCollector(
        createArtifactReferenceLookup(database),
        artifactGarbageCollectionStore,
        {
          ...config.m1.artifactGarbageCollection,
          onError: (error) => {
            logger.error({ error }, 'artifact garbage collection failed');
          },
        },
      );
artifactGarbageCollector?.start();
await Promise.all([reviewWorker?.start(), emailWorker?.start()]);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  healthServer.close();
  await Promise.all([
    reviewWorker?.close(),
    emailWorker?.close(),
    artifactGarbageCollector?.close(),
  ]);
  artifactGarbageCollectionStore?.close();
  await database?.destroy();
  await readinessProbe.close();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
