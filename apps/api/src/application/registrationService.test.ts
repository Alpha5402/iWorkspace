import { decryptSecret } from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PublicAuthRateLimiter } from './publicAuthRateLimiter.js';
import { RegistrationService } from './registrationService.js';

const PEPPER = 'registration-test-pepper-with-enough-entropy';
const EMAIL_KEY = Buffer.alloc(32, 9);

describe('RegistrationService', () => {
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;
  let registration: RegistrationService;

  beforeEach(async () => {
    database = await createMemoryDatabase();
    registration = new RegistrationService(
      database,
      PEPPER,
      { key: EMAIL_KEY, version: 1 },
      new PublicAuthRateLimiter(database, PEPPER),
    );
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('creates one pending account and an encrypted transactional email outbox record', async () => {
    const input = {
      email: ' New.User@Example.com ',
      ipAddress: '192.0.2.1',
      password: 'correct horse battery staple',
    };
    await expect(registration.register(input)).resolves.toEqual({ accepted: true });

    const users = await database.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: 'new.user@example.com',
      platform_role: 'USER',
      status: 'PENDING_VERIFICATION',
    });
    await expect(database.selectFrom('organizations').select('id').execute()).resolves.toEqual([]);
    const deliveries = await database.selectFrom('identity_email_outbox').selectAll().execute();
    expect(deliveries).toHaveLength(1);
    const delivery = await database
      .selectFrom('identity_email_outbox')
      .selectAll()
      .executeTakeFirstOrThrow();
    const serialized = JSON.stringify(delivery);
    expect(serialized).not.toContain('iwverify_');
    const token = decryptSecret(
      {
        aad: delivery.aad,
        ciphertext: delivery.ciphertext,
        encryptedDek: delivery.encrypted_dek,
        iv: delivery.iv,
        keyVersion: delivery.key_version,
        tag: delivery.tag,
        wrapIv: delivery.wrap_iv,
        wrapTag: delivery.wrap_tag,
      },
      EMAIL_KEY,
    );
    expect(token).toMatch(/^iwverify_/);
    const verification = await database
      .selectFrom('email_verification_tokens')
      .select('token_hash')
      .executeTakeFirstOrThrow();
    expect(verification.token_hash).not.toContain(token);
  });

  it('activates the account and creates its personal organization exactly once', async () => {
    await registration.register({
      email: 'user@example.com',
      ipAddress: '192.0.2.2',
      password: 'correct horse battery staple',
    });
    const delivery = await database
      .selectFrom('identity_email_outbox')
      .selectAll()
      .executeTakeFirstOrThrow();
    const token = decryptSecret(
      {
        aad: delivery.aad,
        ciphertext: delivery.ciphertext,
        encryptedDek: delivery.encrypted_dek,
        iv: delivery.iv,
        keyVersion: delivery.key_version,
        tag: delivery.tag,
        wrapIv: delivery.wrap_iv,
        wrapTag: delivery.wrap_tag,
      },
      EMAIL_KEY,
    );

    const verified = await registration.verifyEmail(token);
    await expect(registration.verifyEmail(token)).rejects.toMatchObject({
      code: 'VERIFICATION_TOKEN_INVALID',
      status: 400,
    });
    const user = await database
      .selectFrom('users')
      .select(['id', 'status'])
      .executeTakeFirstOrThrow();
    expect(user.status).toBe('ACTIVE');
    await expect(
      database
        .selectFrom('organization_members')
        .select(['organization_id', 'role', 'user_id'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      organization_id: verified.organizationId,
      role: 'OWNER',
      user_id: user.id,
    });
    await expect(database.selectFrom('organizations').select('id').execute()).resolves.toHaveLength(
      1,
    );
  });

  it('supersedes pending verification and returns the same response for unknown or active emails', async () => {
    await registration.register({
      email: 'user@example.com',
      ipAddress: '192.0.2.3',
      password: 'correct horse battery staple',
    });
    await expect(
      registration.resendVerification({ email: 'user@example.com', ipAddress: '192.0.2.3' }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      registration.resendVerification({ email: 'missing@example.com', ipAddress: '192.0.2.4' }),
    ).resolves.toEqual({ accepted: true });
    const deliveries = await database
      .selectFrom('identity_email_outbox')
      .select(['last_error_code', 'status'])
      .orderBy('created_at', 'asc')
      .execute();
    expect(deliveries).toEqual([
      { last_error_code: 'VERIFICATION_SUPERSEDED', status: 'FAILED' },
      { last_error_code: null, status: 'PENDING' },
    ]);
  });

  it('rejects expired tokens and enforces distributed resend limits without revealing accounts', async () => {
    await registration.register({
      email: 'expired@example.com',
      ipAddress: '192.0.2.5',
      password: 'correct horse battery staple',
    });
    const delivery = await database
      .selectFrom('identity_email_outbox')
      .selectAll()
      .executeTakeFirstOrThrow();
    const token = decryptSecret(
      {
        aad: delivery.aad,
        ciphertext: delivery.ciphertext,
        encryptedDek: delivery.encrypted_dek,
        iv: delivery.iv,
        keyVersion: delivery.key_version,
        tag: delivery.tag,
        wrapIv: delivery.wrap_iv,
        wrapTag: delivery.wrap_tag,
      },
      EMAIL_KEY,
    );
    await database
      .updateTable('email_verification_tokens')
      .set({ created_at: new Date(0), expires_at: new Date(1) })
      .executeTakeFirstOrThrow();
    await expect(registration.verifyEmail(token)).rejects.toMatchObject({
      code: 'VERIFICATION_TOKEN_EXPIRED',
      status: 410,
    });

    const resend = { email: 'unknown@example.com', ipAddress: '192.0.2.6' };
    await registration.resendVerification(resend);
    await registration.resendVerification(resend);
    await registration.resendVerification(resend);
    await expect(registration.resendVerification(resend)).rejects.toMatchObject({
      code: 'PUBLIC_AUTH_RATE_LIMITED',
      status: 429,
    });
  });
});
