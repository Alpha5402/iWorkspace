import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { hashPassword, AccessTokenService, RefreshTokenService } from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminService } from './adminService.js';
import { AuthService, bootstrapFirstAdmin, type UserActor } from './authService.js';
import { PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

const PEPPER = 'admin-service-test-pepper-with-enough-entropy';

describe('AdminService', () => {
  let admin: AdminService;
  let auth: AuthService;
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;
  let superActor: UserActor;

  beforeEach(async () => {
    database = await createMemoryDatabase();
    const accessKeys = createKeySet('access');
    const refreshKeys = createKeySet('refresh');
    auth = new AuthService(
      database,
      new AccessTokenService(accessKeys, 'iworkspace-test', 'iworkspace-access'),
      new RefreshTokenService(refreshKeys, 'iworkspace-test', 'iworkspace-refresh'),
      PEPPER,
      new PublicAuthRateLimiter(database, PEPPER),
    );
    admin = new AdminService(database);
    await bootstrapFirstAdmin({
      database,
      email: 'super@example.com',
      organizationName: 'Platform',
      password: 'correct horse battery staple',
    });
    const session = await auth.login({
      email: 'super@example.com',
      ipAddress: '192.0.2.40',
      password: 'correct horse battery staple',
      userAgent: 'Admin Browser',
    });
    superActor = await auth.verifyAccessToken(session.accessToken);
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('lists users with a stable bounded cursor and returns redacted detail', async () => {
    const first = await createUser('first@example.com');
    const second = await createUser('second@example.com');
    const third = await createUser('third@example.com');
    await database
      .updateTable('users')
      .set({ created_at: new Date('2026-01-01T00:00:00.000Z') })
      .where('id', 'in', [first.userId, second.userId, third.userId])
      .execute();
    await auth.login({
      email: 'second@example.com',
      ipAddress: '192.0.2.41',
      password: 'another secure password',
      userAgent: 'Second Browser',
    });
    const project = await database
      .insertInto('projects')
      .values({ name: 'Token Project', organization_id: second.organizationId, slug: 'tokens' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database
      .insertInto('project_api_tokens')
      .values({
        created_by: second.userId,
        id: randomUUID(),
        name: 'GitHub Action',
        organization_id: second.organizationId,
        project_id: project.id,
        scopes: ['review:trigger'],
        token_hash: 'redacted-hash',
        token_prefix: 'iwpat_test',
      })
      .executeTakeFirstOrThrow();

    const firstPage = await admin.listUsers(superActor, { limit: 2 });
    expect(firstPage.users).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    const secondPage = await admin.listUsers(superActor, {
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    expect(new Set([...firstPage.users, ...secondPage.users].map((user) => user.id)).size).toBe(4);
    await expect(
      admin.listUsers(superActor, { email: 'SECOND@example.com', limit: 10 }),
    ).resolves.toMatchObject({ users: [{ id: second.userId }] });
    await expect(
      admin.listUsers(superActor, { cursor: 'invalid', limit: 10 }),
    ).rejects.toMatchObject({ code: 'ADMIN_USER_CURSOR_INVALID', status: 400 });

    const detail = await admin.getUser(superActor, second.userId);
    expect(detail).toMatchObject({
      email: 'second@example.com',
      memberships: [{ organizationId: second.organizationId, role: 'OWNER' }],
      sessions: [
        {
          active: true,
          ipAddress: '192.0.2.41',
          userAgent: 'Second Browser',
        },
      ],
      tokens: [
        {
          name: 'GitHub Action',
          projectId: project.id,
          projectName: 'Token Project',
          scopes: ['review:trigger'],
          tokenPrefix: 'iwpat_test',
        },
      ],
    });
    expect(JSON.stringify(detail)).not.toMatch(/password|token_hash|csrf|cookie/i);
  });

  it('lets ADMIN manage ordinary users but not administrators, and audits suspension', async () => {
    const administrator = await createUser('administrator@example.com');
    const ordinary = await createUser('ordinary@example.com');
    await admin.setPlatformRole(
      superActor,
      administrator.userId,
      'ADMIN',
      'Delegate user support',
      'trace-role',
    );
    const administratorSession = await auth.login({
      email: 'administrator@example.com',
      ipAddress: '192.0.2.42',
      password: 'another secure password',
    });
    const administratorActor = await auth.verifyAccessToken(administratorSession.accessToken);
    const ordinarySession = await auth.login({
      email: 'ordinary@example.com',
      ipAddress: '192.0.2.43',
      password: 'another secure password',
    });

    await expect(
      admin.setUserStatus(
        administratorActor,
        ordinary.userId,
        'SUSPENDED',
        'Abuse investigation',
        'trace-suspend',
      ),
    ).resolves.toMatchObject({ status: 'SUSPENDED' });
    await expect(auth.verifyAccessToken(ordinarySession.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });
    await expect(
      admin.setUserStatus(
        administratorActor,
        superActor.userId,
        'SUSPENDED',
        'Invalid escalation',
        'trace-denied',
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_USER_MANAGEMENT_DENIED', status: 403 });
    await expect(
      admin.setPlatformRole(
        administratorActor,
        ordinary.userId,
        'ADMIN',
        'Invalid promotion',
        'trace-denied-role',
      ),
    ).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED', status: 403 });

    const audit = await database
      .selectFrom('audit_events')
      .select(['action', 'metadata', 'target_id'])
      .where('action', '=', 'platform.user.status_changed')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({
      action: 'platform.user.status_changed',
      metadata: {
        fromStatus: 'ACTIVE',
        reason: 'Abuse investigation',
        toStatus: 'SUSPENDED',
      },
      target_id: ordinary.userId,
    });
  });

  it('protects the last active SUPER_ADMIN and keeps role mutations explicit', async () => {
    const ordinary = await createUser('role-target@example.com');
    await expect(
      admin.setUserStatus(
        superActor,
        ordinary.userId,
        'ACTIVE',
        'Confirm current state',
        'trace-status-noop',
      ),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    await expect(
      admin.setUserStatus(
        superActor,
        superActor.userId,
        'SUSPENDED',
        'Would remove last root',
        'trace-last-super',
      ),
    ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN_PROTECTED', status: 409 });
    await expect(
      admin.setPlatformRole(
        superActor,
        ordinary.userId,
        'ADMIN',
        'Add support administrator',
        'trace-promote',
      ),
    ).resolves.toMatchObject({ platformRole: 'ADMIN' });
    await expect(
      admin.setPlatformRole(
        superActor,
        ordinary.userId,
        'USER',
        'Remove support access',
        'trace-demote',
      ),
    ).resolves.toMatchObject({ platformRole: 'USER' });
    await expect(
      admin.setPlatformRole(
        superActor,
        superActor.userId,
        'USER',
        'Protected role',
        'trace-protected-role',
      ),
    ).rejects.toMatchObject({ code: 'SUPER_ADMIN_ROLE_PROTECTED', status: 409 });
    await expect(
      database
        .selectFrom('audit_events')
        .select('action')
        .where('action', '=', 'platform.user.status_change_requested')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ action: 'platform.user.status_change_requested' });
  });

  it('revokes all target session families and rejects ordinary platform users', async () => {
    const target = await createUser('sessions@example.com');
    const ordinaryActorUser = await createUser('not-admin@example.com');
    const first = await auth.login({
      email: 'sessions@example.com',
      ipAddress: '192.0.2.44',
      password: 'another secure password',
    });
    await auth.login({
      email: 'sessions@example.com',
      ipAddress: '192.0.2.45',
      password: 'another secure password',
    });
    const ordinaryActor: UserActor = {
      organizationId: ordinaryActorUser.organizationId,
      sessionId: randomUUID(),
      type: 'USER',
      userId: ordinaryActorUser.userId,
    };

    await expect(
      admin.revokeUserSessions(
        ordinaryActor,
        target.userId,
        'Unauthorized request',
        'trace-ordinary',
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED', status: 403 });
    await expect(
      admin.revokeUserSessions(superActor, target.userId, 'Security response', 'trace-revoke'),
    ).resolves.toEqual({ revokedFamilies: 2 });
    await expect(auth.verifyAccessToken(first.accessToken)).rejects.toMatchObject({
      code: 'ACCESS_SESSION_INACTIVE',
    });
  });

  async function createUser(
    email: string,
  ): Promise<Readonly<{ organizationId: string; userId: string }>> {
    const user = await database
      .insertInto('users')
      .values({ email, status: 'ACTIVE' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database
      .insertInto('user_password_credentials')
      .values({ password_hash: await hashPassword('another secure password'), user_id: user.id })
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
    return { organizationId: organization.id, userId: user.id };
  }
});

function createKeySet(label: string): ConstructorParameters<typeof AccessTokenService>[0] {
  const pair = generateKeyPairSync('ed25519');
  const key = {
    keyId: `${label}-test-v1`,
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
  return { current: key, verificationKeys: [key] };
}
