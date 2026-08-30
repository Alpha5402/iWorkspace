import { randomUUID } from 'node:crypto';

import {
  createDatabase,
  createPlatformAdminDatabase,
  type DeliveryDatabase,
} from '@delivery/database';
import { type UserSessionPrincipal } from '@delivery/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdministratorInvitationService } from './administratorInvitationService.js';
import { PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

const describeInfrastructure =
  process.env.RUN_INFRA_INTEGRATION === 'true' ? describe : describe.skip;
const PEPPER = 'administrator-invitation-integration-pepper-with-enough-entropy';

describeInfrastructure('administrator invitations on PostgreSQL', () => {
  let actor: UserSessionPrincipal;
  let administratorDatabase: DeliveryDatabase;
  let database: DeliveryDatabase;
  let organizationId: string;
  let service: AdministratorInvitationService;
  let superAdministratorId: string;
  const email = `administrator-${randomUUID()}@example.com`;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
    database = createDatabase(databaseUrl);
    administratorDatabase = createPlatformAdminDatabase(databaseUrl);
    const superAdministrator = await database
      .insertInto('users')
      .values({
        email: `super-${randomUUID()}@example.com`,
        platform_role: 'SUPER_ADMIN',
        status: 'ACTIVE',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    superAdministratorId = superAdministrator.id;
    const organization = await database
      .insertInto('organizations')
      .values({ name: `Invitation integration ${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    organizationId = organization.id;
    await database
      .insertInto('organization_members')
      .values({ organization_id: organizationId, role: 'OWNER', user_id: superAdministratorId })
      .executeTakeFirstOrThrow();
    actor = {
      organizationId,
      sessionId: randomUUID(),
      type: 'USER_SESSION',
      userId: superAdministratorId,
    };
    service = new AdministratorInvitationService(
      database,
      administratorDatabase,
      PEPPER,
      { key: Buffer.alloc(32, 13), version: 1 },
      new PublicAuthRateLimiter(database, PEPPER),
    );
  });

  afterAll(async () => {
    await database
      .deleteFrom('administrator_invitations')
      .where('email_canonical', '=', email)
      .execute();
    // The actor and organization are deliberately retained because their immutable audit event
    // is part of the integration evidence and holds foreign keys to both records.
    await administratorDatabase.destroy();
    await database.destroy();
  });

  it('serializes concurrent invitations and leaves one pending email intent', async () => {
    const results = await Promise.allSettled([
      service.createInvitation(
        actor,
        { email, idempotencyKey: `first-${randomUUID()}`, reason: 'First operator request' },
        'trace-concurrent-first',
      ),
      service.createInvitation(
        actor,
        { email, idempotencyKey: `second-${randomUUID()}`, reason: 'Second operator request' },
        'trace-concurrent-second',
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(
      database
        .selectFrom('administrator_invitations')
        .select('id')
        .where('email_canonical', '=', email)
        .where('status', '=', 'PENDING')
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      database
        .selectFrom('identity_email_outbox')
        .innerJoin(
          'administrator_invitations',
          'administrator_invitations.id',
          'identity_email_outbox.administrator_invitation_id',
        )
        .select('identity_email_outbox.id')
        .where('administrator_invitations.email_canonical', '=', email)
        .execute(),
    ).resolves.toHaveLength(1);
  });
});
