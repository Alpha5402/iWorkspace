import { createPostgresProbe } from '@delivery/database';
import { createReadinessProbe } from '@delivery/health';
import { createRabbitMqProbe } from '@delivery/messaging';
import { createObjectStorageProbe } from '@delivery/object-storage';
import { afterAll, describe, expect, it } from 'vitest';

import { loadApiConfig } from './config.js';

const integrationEnabled = process.env.RUN_INFRA_INTEGRATION === 'true';
const describeInfrastructure = integrationEnabled ? describe : describe.skip;
const config = integrationEnabled ? loadApiConfig(process.env) : undefined;
const readinessProbe = config
  ? createReadinessProbe([
      createPostgresProbe(config.databaseUrl),
      createRabbitMqProbe(config.rabbitMqUrl),
      createObjectStorageProbe(config.objectStorage),
    ])
  : undefined;

describeInfrastructure('M0 infrastructure', () => {
  afterAll(async () => {
    await readinessProbe?.close();
  });

  it('makes PostgreSQL, RabbitMQ, and object storage ready together', async () => {
    const readiness = await readinessProbe?.check();

    expect(readiness).toEqual({
      dependencies: {
        objectStorage: { status: 'up' },
        postgres: { status: 'up' },
        rabbitmq: { status: 'up' },
      },
      ready: true,
    });
  });
});
