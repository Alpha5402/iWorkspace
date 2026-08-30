import {
  createDatabase,
  createPlatformAdminDatabase,
  createPostgresProbe,
} from '@delivery/database';
import { createReadinessProbe } from '@delivery/health';
import { createRabbitMqProbe } from '@delivery/messaging';
import { createObjectStorageProbe, ImmutableArtifactStore } from '@delivery/object-storage';
import { createLogger, startTelemetry } from '@delivery/observability';
import { AccessTokenService, RefreshTokenService } from '@delivery/security';
import { GitHubAppProvider } from '@delivery/providers-github';

import { AuthService } from './application/authService.js';
import { AdminService } from './application/adminService.js';
import { ControlPlaneService } from './application/controlPlaneService.js';
import { PublicAuthRateLimiter } from './application/publicAuthRateLimiter.js';
import { RegistrationService } from './application/registrationService.js';
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
const database = config.m1 === undefined ? undefined : createDatabase(config.databaseUrl);
const platformAdminDatabase =
  config.m1 === undefined ? undefined : createPlatformAdminDatabase(config.databaseUrl);
const artifactStore =
  config.m1 === undefined ? undefined : new ImmutableArtifactStore(config.objectStorage);
const publicAuthRateLimiter =
  config.m1 === undefined || database === undefined
    ? undefined
    : new PublicAuthRateLimiter(database, config.m1.tokenPepper);
const m1Runtime =
  config.m1 === undefined ||
  database === undefined ||
  artifactStore === undefined ||
  platformAdminDatabase === undefined ||
  publicAuthRateLimiter === undefined
    ? undefined
    : {
        admin: new AdminService(platformAdminDatabase),
        auth: new AuthService(
          database,
          new AccessTokenService(config.m1.authAccessKeys, 'iworkspace', 'iworkspace-access'),
          new RefreshTokenService(config.m1.authRefreshKeys, 'iworkspace', 'iworkspace-refresh'),
          config.m1.tokenPepper,
          publicAuthRateLimiter,
        ),
        artifactStore,
        controlPlane: new ControlPlaneService(
          database,
          config.m1.tokenPepper,
          config.m1.secretKeyEncryptionKey,
          config.m1.reviewModel,
        ),
        github: new GitHubAppProvider(config.m1.githubAppId, config.m1.githubPrivateKeyPem),
        githubAppSlug: config.m1.githubAppSlug,
        githubWebhookSecret: config.m1.githubWebhookSecret,
        registration: new RegistrationService(
          database,
          config.m1.tokenPepper,
          config.m1.emailOutboxKey,
          publicAuthRateLimiter,
        ),
        secureCookies: process.env.NODE_ENV === 'production',
        webOrigin: config.m1.webOrigin,
      };
const app = createApp({
  logger,
  ...(m1Runtime === undefined ? {} : { m1Runtime }),
  readinessProbe,
  serviceName: config.serviceName,
});
const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'api listening');
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'api shutting down');
  server.close();
  await database?.destroy();
  await platformAdminDatabase?.destroy();
  artifactStore?.close();
  await readinessProbe.close();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
