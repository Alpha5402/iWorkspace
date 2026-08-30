import { generateKeyPairSync, randomUUID } from 'node:crypto';

import {
  AccessTokenService,
  decryptSecret,
  hashPassword,
  RefreshTokenService,
} from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdministratorInvitationService } from './administratorInvitationService.js';
import { AuthService, bootstrapFirstAdmin } from './authService.js';
import { PublicAuthRateLimiter } from './publicAuthRateLimiter.js';
import { RegistrationService } from './registrationService.js';

const PEPPER = 'administrator-invitation-test-pepper-with-enough-entropy';
const EMAIL_KEY = Buffer.alloc(32, 12);

describe('AdministratorInvitationService', () => {
  let auth: AuthService;
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;
  let service: AdministratorInvitationService;
  let superActor: Awaited<ReturnType<AuthService['verifyAccessToken']>>;

  beforeEach(async () => {
    database = await createMemoryDatabase();
    const rateLimiter = new PublicAuthRateLimiter(database, PEPPER);
    auth = new AuthService(
      database,
      new AccessTokenService(createKeySet('access'), 'iworkspace-test', 'iworkspace-access'),
      new RefreshTokenService(createKeySet('refresh'), 'iworkspace-test', 'iworkspace-refresh'),
      PEPPER,
      rateLimiter,
    );
    service = new AdministratorInvitationService(
      database,
      database,
      PEPPER,
      { key: EMAIL_KEY, version: 1 },
      rateLimiter,
    );
    await bootstrapFirstAdmin({
      database,
      email: 'super@example.com',
      organizationName: 'Platform',
      password: 'correct horse battery staple',
    });
    const session = await auth.login({
      email: 'super@example.com',
      ipAddress: '192.0.2.80',
      password: 'correct horse battery staple',
    });
    superActor = await auth.verifyAccessToken(session.accessToken);
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('creates one encrypted invitation intent and deduplicates the same request', async () => {
    const input = {
      email: ' New.Admin@Example.com ',
      idempotencyKey: 'administrator-invitation-1',
      reason: 'Add platform operator',
    };
    const created = await service.createInvitation(superActor, input, 'trace-create');
    const duplicate = await service.createInvitation(superActor, input, 'trace-duplicate');

    expect(created).toMatchObject({
      duplicate: false,
      invitation: { email: 'new.admin@example.com', status: 'PENDING', targetRole: 'ADMIN' },
    });
    expect(duplicate).toMatchObject({ duplicate: true, invitation: { id: created.invitation.id } });
    await expect(
      database.selectFrom('administrator_invitations').select('id').execute(),
    ).resolves.toHaveLength(1);
    await expect(
      database.selectFrom('identity_email_outbox').select('id').execute(),
    ).resolves.toHaveLength(1);
    const token = await invitationToken(created.invitation.id);
    expect(token).toMatch(/^iwadmin_/);
    expect(JSON.stringify(created)).not.toContain(token);
    await expect(
      service.createInvitation(
        superActor,
        { ...input, email: 'different@example.com' },
        'trace-conflict',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    await expect(
      service.createInvitation(
        superActor,
        {
          ...input,
          idempotencyKey: 'administrator-invitation-same-email',
        },
        'trace-pending-email',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_ALREADY_PENDING', status: 409 });
  });

  it('requires SUPER_ADMIN and directs existing users to explicit role promotion', async () => {
    const administrator = await createActiveUser('operator@example.com', 'ADMIN');
    const administratorSession = await auth.login({
      email: 'operator@example.com',
      ipAddress: '192.0.2.81',
      password: 'another secure password',
    });
    const administratorActor = await auth.verifyAccessToken(administratorSession.accessToken);
    await expect(
      service.listInvitations(administratorActor, { limit: 25, status: 'PENDING' }),
    ).resolves.toEqual({ invitations: [] });
    await expect(
      service.createInvitation(
        administratorActor,
        {
          email: 'target@example.com',
          idempotencyKey: 'administrator-invitation-2',
          reason: 'Unauthorized delegation',
        },
        'trace-denied',
      ),
    ).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED', status: 403 });
    await expect(
      service.createInvitation(
        superActor,
        {
          email: 'operator@example.com',
          idempotencyKey: 'administrator-invitation-3',
          reason: 'Duplicate account',
        },
        'trace-existing',
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_USER_ALREADY_EXISTS', status: 409 });
    await createActiveUser('ordinary@example.com', 'USER');
    const ordinarySession = await auth.login({
      email: 'ordinary@example.com',
      ipAddress: '192.0.2.90',
      password: 'another secure password',
    });
    await expect(
      service.listInvitations(await auth.verifyAccessToken(ordinarySession.accessToken), {
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED', status: 403 });
    await expect(
      service.listInvitations({ ...superActor, userId: randomUUID() }, { limit: 25 }),
    ).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED', status: 403 });
    const suspendedAdministratorId = await createActiveUser('suspended@example.com', 'ADMIN');
    await database
      .updateTable('users')
      .set({ status: 'SUSPENDED' })
      .where('id', '=', suspendedAdministratorId)
      .executeTakeFirstOrThrow();
    await expect(
      service.listInvitations({ ...superActor, userId: suspendedAdministratorId }, { limit: 25 }),
    ).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED', status: 403 });
    expect(administrator).toBeTypeOf('string');
  });

  it('rotates credentials on resend and revokes invitations without exposing tokens', async () => {
    const created = await service.createInvitation(
      superActor,
      {
        email: 'rotate@example.com',
        idempotencyKey: 'administrator-invitation-4',
        reason: 'Initial invitation',
      },
      'trace-initial',
    );
    const originalToken = await invitationToken(created.invitation.id);
    const resent = await service.resendInvitation(
      superActor,
      created.invitation.id,
      'Original email was lost',
      'trace-resend',
    );
    const rotatedToken = await invitationToken(created.invitation.id);
    expect(rotatedToken).not.toBe(originalToken);
    expect(resent.delivery.status).toBe('PENDING');
    await expect(
      service.acceptInvitation(
        { ipAddress: '192.0.2.82', password: 'another secure password', token: originalToken },
        'trace-old-token',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_INVALID', status: 400 });

    const revoked = await service.revokeInvitation(
      superActor,
      created.invitation.id,
      'Access no longer required',
      'trace-revoke',
    );
    expect(revoked).toMatchObject({
      delivery: { errorCode: 'INVITATION_REVOKED', status: 'FAILED' },
      status: 'REVOKED',
    });
    expect(revoked.revokedAt).toBeTypeOf('string');
    const repeatedRevocation = await service.revokeInvitation(
      superActor,
      created.invitation.id,
      'Confirm the credential remains revoked',
      'trace-revoke-repeat',
    );
    expect(repeatedRevocation.status).toBe('REVOKED');
    await expect(
      service.resendInvitation(
        superActor,
        created.invitation.id,
        'Attempt to revive a terminal invitation',
        'trace-resend-revoked',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_TERMINAL', status: 409 });
    await expect(
      service.listInvitations(superActor, { limit: 25, status: 'REVOKED' }),
    ).resolves.toMatchObject({ invitations: [{ id: created.invitation.id }] });
    await expect(
      service.acceptInvitation(
        { ipAddress: '192.0.2.83', password: 'another secure password', token: rotatedToken },
        'trace-revoked-token',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_INVALID', status: 400 });
  });

  it('atomically activates an ADMIN with a personal organization and supports JWT login', async () => {
    const created = await service.createInvitation(
      superActor,
      {
        email: 'accepted@example.com',
        idempotencyKey: 'administrator-invitation-5',
        reason: 'Add trusted operator',
      },
      'trace-create-accepted',
    );
    const token = await invitationToken(created.invitation.id);
    const accepted = await service.acceptInvitation(
      { ipAddress: '192.0.2.84', password: 'another secure password', token },
      'trace-accept',
    );

    await expect(
      database
        .selectFrom('users')
        .select(['platform_role', 'status'])
        .where('id', '=', accepted.userId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ platform_role: 'ADMIN', status: 'ACTIVE' });
    await expect(
      database
        .selectFrom('organization_members')
        .select(['organization_id', 'role', 'user_id'])
        .where('user_id', '=', accepted.userId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      organization_id: accepted.organizationId,
      role: 'OWNER',
      user_id: accepted.userId,
    });
    const session = await auth.login({
      email: 'accepted@example.com',
      ipAddress: '192.0.2.85',
      password: 'another secure password',
    });
    expect(session.accessToken.split('.')).toHaveLength(3);
    expect(session.refreshToken.split('.')).toHaveLength(3);
    await expect(
      service.acceptInvitation(
        { ipAddress: '192.0.2.86', password: 'another secure password', token },
        'trace-replay',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_INVALID', status: 400 });
    await expect(
      database
        .selectFrom('audit_events')
        .select(['action', 'actor_type'])
        .where('target_id', '=', accepted.userId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      action: 'platform.administrator_invitation.accepted',
      actor_type: 'SYSTEM',
    });
    const acceptedPage = await service.listInvitations(superActor, {
      limit: 25,
      status: 'ACCEPTED',
    });
    expect(acceptedPage.invitations).toMatchObject([
      { acceptedUserId: accepted.userId, id: created.invitation.id },
    ]);
    expect(acceptedPage.invitations.at(0)?.acceptedAt).toBeTypeOf('string');
    await expect(
      service.revokeInvitation(
        superActor,
        created.invitation.id,
        'Accepted invitations are immutable',
        'trace-revoke-accepted',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_TERMINAL', status: 409 });
    await expect(
      service.resendInvitation(
        superActor,
        created.invitation.id,
        'Accepted invitations cannot rotate credentials',
        'trace-resend-accepted',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_TERMINAL', status: 409 });
  });

  it('rejects activation if the email becomes occupied after invitation issuance', async () => {
    const created = await service.createInvitation(
      superActor,
      {
        email: 'race@example.com',
        idempotencyKey: 'administrator-invitation-race',
        reason: 'Exercise the invitation and registration race boundary',
      },
      'trace-race-create',
    );
    const token = await invitationToken(created.invitation.id);
    await database
      .insertInto('users')
      .values({ email: 'race@example.com', platform_role: 'USER', status: 'ACTIVE' })
      .executeTakeFirstOrThrow();

    await expect(
      service.acceptInvitation(
        { ipAddress: '192.0.2.91', password: 'another secure password', token },
        'trace-race-accept',
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_USER_ALREADY_EXISTS', status: 409 });
    await expect(
      database
        .selectFrom('administrator_invitations')
        .select('status')
        .where('id', '=', created.invitation.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'PENDING' });
  });

  it('derives expiry from the database clock, paginates stably, and revives only by rotation', async () => {
    const expired = await service.createInvitation(
      superActor,
      {
        email: 'expired@example.com',
        idempotencyKey: 'administrator-invitation-expired',
        reason: 'Exercise expiration handling',
      },
      'trace-expired',
    );
    const originalToken = await invitationToken(expired.invitation.id);
    const expiredAt = new Date(Date.now() - 60_000);
    await database
      .updateTable('administrator_invitations')
      .set({
        created_at: new Date(expiredAt.getTime() - 60_000),
        expires_at: expiredAt,
        updated_at: expiredAt,
      })
      .where('id', '=', expired.invitation.id)
      .executeTakeFirstOrThrow();
    const second = await service.createInvitation(
      superActor,
      {
        email: 'second-page@example.com',
        idempotencyKey: 'administrator-invitation-page',
        reason: 'Exercise stable pagination',
      },
      'trace-page',
    );

    const expiredPage = await service.listInvitations(superActor, {
      limit: 1,
      status: 'EXPIRED',
    });
    expect(expiredPage.invitations).toMatchObject([
      { id: expired.invitation.id, status: 'EXPIRED' },
    ]);
    const firstPage = await service.listInvitations(superActor, { limit: 1 });
    expect(firstPage.invitations).toMatchObject([{ id: second.invitation.id }]);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    if (firstPage.nextCursor === undefined) throw new Error('NEXT_CURSOR_REQUIRED');
    const secondPage = await service.listInvitations(superActor, {
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(secondPage.invitations).toMatchObject([{ id: expired.invitation.id }]);
    await expect(
      service.listInvitations(superActor, { cursor: 'not-a-valid-cursor', limit: 1 }),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_CURSOR_INVALID', status: 400 });
    await database
      .updateTable('identity_email_outbox')
      .set({ sent_at: new Date(), status: 'SENT' })
      .where('administrator_invitation_id', '=', second.invitation.id)
      .executeTakeFirstOrThrow();
    const pendingPage = await service.listInvitations(superActor, {
      limit: 25,
      status: 'PENDING',
    });
    expect(pendingPage.invitations).toMatchObject([{ delivery: { status: 'SENT' } }]);
    expect(pendingPage.invitations.at(0)?.delivery.sentAt).toBeTypeOf('string');
    await expect(
      service.acceptInvitation(
        { ipAddress: '192.0.2.88', password: 'another secure password', token: originalToken },
        'trace-expired-accept',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_EXPIRED', status: 410 });

    await service.resendInvitation(
      superActor,
      expired.invitation.id,
      'Issue a fresh time-bounded credential',
      'trace-expired-resend',
    );
    expect(await invitationToken(expired.invitation.id)).not.toBe(originalToken);
    await expect(
      service.acceptInvitation(
        { ipAddress: '192.0.2.89', password: 'another secure password', token: originalToken },
        'trace-expired-old-token',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_INVALID', status: 400 });
    await expect(
      service.resendInvitation(
        superActor,
        randomUUID(),
        'Missing invitation probe',
        'trace-missing',
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATOR_INVITATION_NOT_FOUND', status: 404 });
  });

  it('keeps public registration generic while a live administrator invitation owns the email', async () => {
    await service.createInvitation(
      superActor,
      {
        email: 'reserved@example.com',
        idempotencyKey: 'administrator-invitation-6',
        reason: 'Reserve administrator identity',
      },
      'trace-reserved',
    );
    const registration = new RegistrationService(
      database,
      PEPPER,
      { key: EMAIL_KEY, version: 1 },
      new PublicAuthRateLimiter(database, PEPPER),
    );
    await expect(
      registration.register({
        email: 'reserved@example.com',
        ipAddress: '192.0.2.87',
        password: 'public registration password',
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      database
        .selectFrom('users')
        .select('id')
        .where('email_canonical', '=', 'reserved@example.com')
        .execute(),
    ).resolves.toEqual([]);
  });

  async function invitationToken(invitationId: string): Promise<string> {
    const delivery = await database
      .selectFrom('identity_email_outbox')
      .selectAll()
      .where('administrator_invitation_id', '=', invitationId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    return decryptSecret(
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
  }

  async function createActiveUser(email: string, platformRole: 'ADMIN' | 'USER'): Promise<string> {
    const user = await database
      .insertInto('users')
      .values({ email, platform_role: platformRole, status: 'ACTIVE' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database
      .insertInto('user_password_credentials')
      .values({
        password_hash: await hashPassword('another secure password'),
        user_id: user.id,
      })
      .executeTakeFirstOrThrow();
    const organization = await database
      .insertInto('organizations')
      .values({ name: `${email} workspace` })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database
      .insertInto('organization_members')
      .values({ organization_id: organization.id, role: 'OWNER', user_id: user.id })
      .executeTakeFirstOrThrow();
    return user.id;
  }
});

function createKeySet(label: string): ConstructorParameters<typeof AccessTokenService>[0] {
  const pair = generateKeyPairSync('ed25519');
  const key = {
    keyId: `${label}-${randomUUID()}`,
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
  return { current: key, verificationKeys: [key] };
}
