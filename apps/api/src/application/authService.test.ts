import { generateKeyPairSync } from 'node:crypto';

import { AccessTokenService } from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type HttpError } from '../errors.js';
import { AuthService, bootstrapFirstAdmin } from './authService.js';

const PEPPER = 'test-only-token-pepper-with-enough-entropy';

function createAccessTokens(): AccessTokenService {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return new AccessTokenService(
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey.export({ format: 'pem', type: 'spki' }),
    'iworkspace-test',
    'iworkspace-web',
  );
}

describe('AuthService', () => {
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;
  let auth: AuthService;
  let organizationId: string;

  beforeEach(async () => {
    database = await createMemoryDatabase();
    auth = new AuthService(database, createAccessTokens(), PEPPER);
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

    expect(session.refreshToken).toMatch(/^iwrf_/);
    expect(session.user).toMatchObject({ organizationId, organizationRole: 'OWNER' });
    await expect(auth.verifyAccessToken(session.accessToken)).resolves.toMatchObject({
      organizationId,
      type: 'USER',
      userId: session.user.id,
    });
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
    await auth.logout({ ...actor, sessionId: crypto.randomUUID() });
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_EXPIRED',
    });
  });
});
