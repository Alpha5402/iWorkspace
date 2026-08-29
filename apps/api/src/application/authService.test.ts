import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { AccessTokenService, hashPassword, RefreshTokenService } from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type HttpError } from '../errors.js';
import { AuthService, bootstrapFirstAdmin } from './authService.js';
import { PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

const PEPPER = 'test-only-token-pepper-with-enough-entropy';

function createTokenServices(): Readonly<{
  access: AccessTokenService;
  refresh: RefreshTokenService;
}> {
  const accessPair = generateKeyPairSync('ed25519');
  const refreshPair = generateKeyPairSync('ed25519');
  const accessKey = {
    keyId: 'access-test-v1',
    privateKeyPem: accessPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: accessPair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
  const refreshKey = {
    keyId: 'refresh-test-v1',
    privateKeyPem: refreshPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: refreshPair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
  return {
    access: new AccessTokenService(
      { current: accessKey, verificationKeys: [accessKey] },
      'iworkspace-test',
      'iworkspace-access',
    ),
    refresh: new RefreshTokenService(
      { current: refreshKey, verificationKeys: [refreshKey] },
      'iworkspace-test',
      'iworkspace-refresh',
    ),
  };
}

describe('AuthService', () => {
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;
  let auth: AuthService;
  let organizationId: string;

  beforeEach(async () => {
    database = await createMemoryDatabase();
    const tokens = createTokenServices();
    auth = new AuthService(
      database,
      tokens.access,
      tokens.refresh,
      PEPPER,
      new PublicAuthRateLimiter(database, PEPPER),
    );
    ({ organizationId } = await bootstrapFirstAdmin({
      database,
      email: 'Owner@Example.com',
      organizationName: 'Example',
      password: 'correct horse battery staple',
    }));
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('logs in without exposing credentials and verifies the short-lived access token', async () => {
    await expect(
      auth.login({
        email: 'owner@example.com',
        ipAddress: '192.0.2.10',
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });

    const session = await auth.login({
      email: ' owner@example.com ',
      ipAddress: '192.0.2.10',
      organizationId,
      password: 'correct horse battery staple',
    });

    expect(session.refreshToken.split('.')).toHaveLength(3);
    expect(session.user).toMatchObject({ organizationId, organizationRole: 'OWNER' });
    await expect(auth.verifyAccessToken(session.accessToken)).resolves.toMatchObject({
      organizationId,
      type: 'USER_SESSION',
      userId: session.user.id,
    });
    const bootstrappedUser = await database
      .selectFrom('users')
      .select(['platform_role', 'status'])
      .where('id', '=', session.user.id)
      .executeTakeFirstOrThrow();
    expect(bootstrappedUser).toEqual({ platform_role: 'SUPER_ADMIN', status: 'ACTIVE' });
  });

  it('rotates refresh tokens and commits family revocation when an old token is reused', async () => {
    const first = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.11',
      password: 'correct horse battery staple',
    });
    const second = await auth.refresh(first.refreshToken);

    await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
      status: 401,
    } satisfies Partial<HttpError>);
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_EXPIRED',
      status: 401,
    } satisfies Partial<HttpError>);
    const sessions = await database.selectFrom('refresh_sessions').select('revoked_at').execute();
    expect(sessions.every((session) => session.revoked_at !== null)).toBe(true);
  });

  it('accepts a one-time invitation and rejects replay', async () => {
    const owner = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.12',
      password: 'correct horse battery staple',
    });
    const actor = await auth.verifyAccessToken(owner.accessToken);
    const { ControlPlaneService } = await import('./controlPlaneService.js');
    const control = new ControlPlaneService(database, PEPPER);
    const invitation = await control.createInvitation(
      actor,
      { email: 'member@example.com', role: 'MEMBER' },
      'trace-invite',
    );

    await expect(
      auth.acceptInvitation({ password: 'another secure password', token: invitation.token }),
    ).resolves.toEqual({ organizationId });
    await expect(
      auth.acceptInvitation({ password: 'another secure password', token: invitation.token }),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID', status: 410 });
    await expect(
      auth.login({
        email: 'member@example.com',
        ipAddress: '192.0.2.13',
        password: 'another secure password',
      }),
    ).resolves.toMatchObject({ user: { organizationRole: 'MEMBER' } });
  });

  it('prevents bootstrap from being run twice and makes logout idempotent', async () => {
    await expect(
      bootstrapFirstAdmin({
        database,
        email: 'second@example.com',
        organizationName: 'Second',
        password: 'another secure password',
      }),
    ).rejects.toThrow('BOOTSTRAP_ALREADY_COMPLETED');
    const session = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.14',
      password: 'correct horse battery staple',
    });
    const actor = await auth.verifyAccessToken(session.accessToken);
    await auth.logout(actor);
    await expect(auth.verifyAccessToken(session.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
      status: 401,
    });
    await auth.logout({ ...actor, sessionId: crypto.randomUUID() });
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_EXPIRED',
    });
  });

  it('rejects access and refresh credentials immediately after account suspension', async () => {
    const session = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.15',
      password: 'correct horse battery staple',
    });
    await database
      .updateTable('users')
      .set({ status: 'SUSPENDED' })
      .where('id', '=', session.user.id)
      .executeTakeFirstOrThrow();

    await expect(auth.verifyAccessToken(session.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_EXPIRED',
    });
  });

  it('fails closed when credentials have no tenant membership or are not a valid refresh JWT', async () => {
    const userWithoutOrganization = await database
      .insertInto('users')
      .values({ email: 'orphan@example.com', status: 'ACTIVE' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database
      .insertInto('user_password_credentials')
      .values({
        password_hash: await hashPassword('another secure password'),
        user_id: userWithoutOrganization.id,
      })
      .executeTakeFirstOrThrow();

    await expect(
      auth.login({
        email: 'orphan@example.com',
        ipAddress: '192.0.2.16',
        password: 'another secure password',
      }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_DENIED', status: 403 });
    await expect(auth.refresh('not-a-jwt')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      status: 401,
    });
  });

  it('rate limits repeated login attempts before password verification work', async () => {
    const attempt = (): ReturnType<typeof auth.login> =>
      auth.login({
        email: 'missing@example.com',
        ipAddress: '192.0.2.99',
        password: 'incorrect password',
      });
    for (let index = 0; index < 10; index += 1) {
      await expect(attempt()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    }
    await expect(attempt()).rejects.toMatchObject({
      code: 'PUBLIC_AUTH_RATE_LIMITED',
      status: 429,
    });
  });

  it('lists memberships and switches organizations by revoking the previous family', async () => {
    const secondOrganization = await database
      .insertInto('organizations')
      .values({ name: 'Second Organization' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const user = await database
      .selectFrom('users')
      .select('id')
      .where('email_canonical', '=', 'owner@example.com')
      .executeTakeFirstOrThrow();
    await database
      .insertInto('organization_members')
      .values({ organization_id: secondOrganization.id, role: 'ADMIN', user_id: user.id })
      .executeTakeFirstOrThrow();
    const original = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.100',
      password: 'correct horse battery staple',
      userAgent: 'Original Browser',
    });
    const actor = await auth.verifyAccessToken(original.accessToken);

    await expect(auth.listOrganizations(actor)).resolves.toEqual([
      { current: true, id: organizationId, name: 'Example', role: 'OWNER' },
      {
        current: false,
        id: secondOrganization.id,
        name: 'Second Organization',
        role: 'ADMIN',
      },
    ]);
    const switched = await auth.switchOrganization(actor, secondOrganization.id, {
      ipAddress: '192.0.2.101',
      userAgent: 'Switched Browser',
    });
    await expect(auth.verifyAccessToken(original.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });
    await expect(auth.verifyAccessToken(switched.accessToken)).resolves.toMatchObject({
      organizationId: secondOrganization.id,
      userId: user.id,
    });
    await expect(
      auth.switchOrganization(await auth.verifyAccessToken(switched.accessToken), randomUUID(), {}),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_DENIED', status: 403 });
  });

  it('lists, revokes, and globally closes session families without exposing credentials', async () => {
    const first = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.102',
      password: 'correct horse battery staple',
      userAgent: 'First Browser',
    });
    const second = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.103',
      password: 'correct horse battery staple',
      userAgent: 'Second Browser',
    });
    const firstActor = await auth.verifyAccessToken(first.accessToken);
    const secondActor = await auth.verifyAccessToken(second.accessToken);
    const sessions = await auth.listSessions(firstActor);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.current)).toMatchObject({
      ipAddress: '192.0.2.102',
      userAgent: 'First Browser',
    });
    expect(JSON.stringify(sessions)).not.toMatch(/token|csrf|cookie/i);
    const secondSummary = sessions.find((session) => !session.current);
    if (secondSummary === undefined) throw new Error('SECOND_SESSION_REQUIRED');
    await expect(auth.revokeSession(firstActor, secondSummary.sessionId)).resolves.toEqual({
      currentSessionRevoked: false,
    });
    await expect(auth.verifyAccessToken(second.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });

    const third = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.104',
      password: 'correct horse battery staple',
    });
    await expect(auth.logoutOtherSessions(firstActor)).resolves.toEqual({ revokedFamilies: 1 });
    await expect(auth.verifyAccessToken(third.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });
    await expect(auth.logoutAllSessions(firstActor)).resolves.toEqual({ revokedFamilies: 1 });
    await expect(auth.verifyAccessToken(first.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });
    await expect(auth.revokeSession(secondActor, randomUUID())).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
  });

  it('fails closed for stale session actors and reports current-family revocation', async () => {
    const current = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.105',
      password: 'correct horse battery staple',
    });
    const actor = await auth.verifyAccessToken(current.accessToken);
    const staleActor = { ...actor, sessionId: randomUUID() };

    await expect(auth.logoutOtherSessions(actor)).resolves.toEqual({ revokedFamilies: 0 });
    await expect(auth.logoutOtherSessions(staleActor)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
      status: 401,
    });
    await expect(auth.switchOrganization(staleActor, organizationId, {})).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
      status: 401,
    });
    await expect(auth.revokeSession(actor, actor.sessionId)).resolves.toEqual({
      currentSessionRevoked: true,
    });
    await expect(auth.logoutAllSessions(actor)).resolves.toEqual({ revokedFamilies: 0 });
  });

  it('changes the password atomically and invalidates every existing session family', async () => {
    const first = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.106',
      password: 'correct horse battery staple',
    });
    await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.107',
      password: 'correct horse battery staple',
    });
    const actor = await auth.verifyAccessToken(first.accessToken);

    await expect(
      auth.changePassword(
        actor,
        { currentPassword: 'incorrect current password', newPassword: 'a new secure password' },
        'trace-password-invalid',
      ),
    ).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_INVALID', status: 401 });
    await expect(
      auth.changePassword(
        actor,
        {
          currentPassword: 'correct horse battery staple',
          newPassword: 'correct horse battery staple',
        },
        'trace-password-same',
      ),
    ).rejects.toMatchObject({ code: 'PASSWORD_UNCHANGED', status: 409 });
    await expect(
      auth.changePassword(
        actor,
        {
          currentPassword: 'correct horse battery staple',
          newPassword: 'a new secure password',
        },
        'trace-password-change',
      ),
    ).resolves.toEqual({ revokedFamilies: 2 });
    await expect(auth.verifyAccessToken(first.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });
    await expect(
      auth.login({
        email: 'owner@example.com',
        ipAddress: '192.0.2.108',
        password: 'correct horse battery staple',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(
      auth.login({
        email: 'owner@example.com',
        ipAddress: '192.0.2.108',
        password: 'a new secure password',
      }),
    ).resolves.toMatchObject({ user: { id: actor.userId } });
    await expect(
      database
        .selectFrom('audit_events')
        .select(['action', 'metadata'])
        .where('action', '=', 'identity.password.changed')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      action: 'identity.password.changed',
      metadata: { revokedFamilies: 2, subjectUserId: actor.userId },
    });
  });
});
