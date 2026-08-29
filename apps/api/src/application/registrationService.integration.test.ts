import { createHmac, randomUUID } from 'node:crypto';

import { createDatabase, type DeliveryDatabase } from '@delivery/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PublicAuthRateLimiter } from './publicAuthRateLimiter.js';
import { RegistrationService } from './registrationService.js';

const describeInfrastructure =
  process.env.RUN_INFRA_INTEGRATION === 'true' ? describe : describe.skip;
const PEPPER = 'registration-integration-pepper-with-enough-entropy';
const EMAIL_KEY = Buffer.alloc(32, 7);

describeInfrastructure('public registration on PostgreSQL', () => {
  let database: DeliveryDatabase;
  const unique = randomUUID();
  const email = `concurrent-${unique}@example.com`;
  const ipAddress = `integration-${unique}`;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
    database = createDatabase(databaseUrl);
  });

  afterAll(async () => {
    await database.deleteFrom('users').where('email_canonical', '=', email).execute();
    const hashes = [email, ipAddress].map((value) =>
      createHmac('sha256', PEPPER).update(value).digest('hex'),
    );
    await database.deleteFrom('public_rate_limits').where('key_hash', 'in', hashes).execute();
    await database.destroy();
  });

  it('collapses concurrent duplicate requests into one account and one email intent', async () => {
    const registration = new RegistrationService(
      database,
      PEPPER,
      { key: EMAIL_KEY, version: 1 },
      new PublicAuthRateLimiter(database, PEPPER),
    );
    const input = { email, ipAddress, password: 'correct horse battery staple' };

    await expect(
      Promise.all([registration.register(input), registration.register(input)]),
    ).resolves.toEqual([{ accepted: true }, { accepted: true }]);

    const users = await database
      .selectFrom('users')
      .select('id')
      .where('email_canonical', '=', email)
      .execute();
    expect(users).toHaveLength(1);
    const user = users.at(0);
    if (user === undefined) throw new Error('REGISTERED_USER_REQUIRED');
    await expect(
      database
        .selectFrom('user_password_credentials')
        .select('user_id')
        .where('user_id', '=', user.id)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      database
        .selectFrom('email_verification_tokens')
        .innerJoin(
          'identity_email_outbox',
          'identity_email_outbox.verification_token_id',
          'email_verification_tokens.id',
        )
        .select('identity_email_outbox.id')
        .where('email_verification_tokens.user_id', '=', user.id)
        .execute(),
    ).resolves.toHaveLength(1);
  });
});
