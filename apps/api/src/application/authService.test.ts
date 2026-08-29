import { generateKeyPairSync } from 'node:crypto';

import { AccessTokenService, hashPassword, RefreshTokenService } from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type HttpError } from '../errors.js';
import { AuthService, bootstrapFirstAdmin } from './authService.js';

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
    auth = new AuthService(database, tokens.access, tokens.refresh, PEPPER);
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
      auth.login({ email: 'owner@example.com', password: 'wrong-password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });

    const session = await auth.login({
      email: ' owner@example.com ',
      organizationId,
      password: 'correct horse battery staple',
    });

    expect(session.refreshToken.split('.')).toHaveLength(3);
    expect(session.user).toMatchObject({ organizationId, organizationRole: 'OWNER' });
    await expect(auth.verifyAccessToken(session.accessToken)).resolves.toMatchObject({
      organizationId,
      type: 'USER',
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
      auth.login({ email: 'member@example.com', password: 'another secure password' }),
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
      auth.login({ email: 'orphan@example.com', password: 'another secure password' }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_ACCESS_DENIED', status: 403 });
    await expect(auth.refresh('not-a-jwt')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      status: 401,
    });
  });
});
