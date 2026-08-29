import {
  acquirePlatformAdminMutationLock,
  type DeliveryDatabase,
  type DeliveryTransaction,
  getDatabaseNow,
} from '@delivery/database';
import { principalAuditMetadata, principalId, type UserSessionPrincipal } from '@delivery/security';
import { z } from 'zod';

import { HttpError } from '../errors.js';
import {
  summarizeSessionFamilies,
  type SessionRow,
  type SessionSummary,
} from './sessionSummaries.js';

type PlatformRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER';
type UserStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED';

const CursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

export type PlatformUserSummary = Readonly<{
  createdAt: string;
  email: string;
  id: string;
  platformRole: PlatformRole;
  status: UserStatus;
  updatedAt: string;
}>;

export type PlatformUserPage = Readonly<{
  nextCursor?: string;
  users: readonly PlatformUserSummary[];
}>;

export type PlatformUserDetail = PlatformUserSummary &
  Readonly<{
    memberships: readonly Readonly<{
      organizationId: string;
      organizationName: string;
      role: 'OWNER' | 'ADMIN' | 'MEMBER';
    }>[];
    sessions: readonly SessionSummary[];
    tokens: readonly Readonly<{
      createdAt: string;
      expiresAt?: string;
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      revokedAt?: string;
      scopes: readonly string[];
      tokenPrefix: string;
    }>[];
  }>;

export class AdminService {
  public constructor(private readonly database: DeliveryDatabase) {}

  public async listUsers(
    actor: UserSessionPrincipal,
    input: Readonly<{
      cursor?: string | undefined;
      email?: string | undefined;
      limit: number;
      platformRole?: PlatformRole | undefined;
      status?: UserStatus | undefined;
    }>,
  ): Promise<PlatformUserPage> {
    await this.assertPlatformAdministrator(this.database, actor);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    let query = this.database
      .selectFrom('users')
      .select(['created_at', 'email', 'id', 'platform_role', 'status', 'updated_at']);
    if (input.email !== undefined) {
      query = query.where('email_canonical', '=', canonicalizeEmail(input.email));
    }
    if (input.platformRole !== undefined) {
      query = query.where('platform_role', '=', input.platformRole);
    }
    if (input.status !== undefined) query = query.where('status', '=', input.status);
    if (cursor !== undefined) {
      const createdAt = new Date(cursor.createdAt);
      query = query.where((expression) =>
        expression.or([
          expression('created_at', '<', createdAt),
          expression.and([
            expression('created_at', '=', createdAt),
            expression('id', '<', cursor.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      ...(rows.length > input.limit && last !== undefined
        ? { nextCursor: encodeCursor(last.created_at, last.id) }
        : {}),
      users: pageRows.map(mapUserSummary),
    };
  }

  public async getUser(actor: UserSessionPrincipal, userId: string): Promise<PlatformUserDetail> {
    await this.assertPlatformAdministrator(this.database, actor);
    const user = await this.database
      .selectFrom('users')
      .select(['created_at', 'email', 'id', 'platform_role', 'status', 'updated_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (user === undefined) throw userNotFound();
    const [memberships, sessionRows, tokens, databaseNow] = await Promise.all([
      this.database
        .selectFrom('organization_members')
        .innerJoin('organizations', 'organizations.id', 'organization_members.organization_id')
        .select([
          'organization_members.organization_id',
          'organization_members.role',
          'organizations.name',
        ])
        .where('organization_members.user_id', '=', userId)
        .orderBy('organizations.created_at', 'asc')
        .orderBy('organizations.id', 'asc')
        .execute(),
      this.selectSessionRows(userId),
      this.database
        .selectFrom('platform_admin_user_token_metadata')
        .select([
          'created_at',
          'expires_at',
          'id',
          'name',
          'project_id',
          'project_name',
          'revoked_at',
          'scopes',
          'token_prefix',
        ])
        .where('created_by', '=', userId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute(),
      getDatabaseNow(this.database),
    ]);
    return {
      ...mapUserSummary(user),
      memberships: memberships.map((membership) => ({
        organizationId: membership.organization_id,
        organizationName: membership.name,
        role: membership.role,
      })),
      sessions: summarizeSessionFamilies(sessionRows, databaseNow),
      tokens: tokens.map((token) => ({
        createdAt: token.created_at.toISOString(),
        ...(token.expires_at === null ? {} : { expiresAt: token.expires_at.toISOString() }),
        id: token.id,
        name: token.name,
        projectId: token.project_id,
        projectName: token.project_name,
        ...(token.revoked_at === null ? {} : { revokedAt: token.revoked_at.toISOString() }),
        scopes: token.scopes,
        tokenPrefix: token.token_prefix,
      })),
    };
  }

  public async setUserStatus(
    actor: UserSessionPrincipal,
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string,
    traceId: string,
  ): Promise<PlatformUserSummary> {
    return this.database.transaction().execute(async (transaction) => {
      await acquirePlatformAdminMutationLock(transaction);
      const { actorRole, target } = await this.loadMutationActors(transaction, actor, userId);
      assertCanManageTarget(actorRole, target.platform_role);
      if (target.status === status) {
        await this.audit(
          transaction,
          actor,
          'platform.user.status_change_requested',
          userId,
          reason,
          traceId,
          { noChange: true, status },
        );
        return mapUserSummary(target);
      }
      if (
        (target.status !== 'ACTIVE' || status !== 'SUSPENDED') &&
        (target.status !== 'SUSPENDED' || status !== 'ACTIVE')
      ) {
        throw new HttpError(
          409,
          'USER_STATUS_TRANSITION_INVALID',
          'The requested user status transition is not allowed.',
        );
      }
      if (target.platform_role === 'SUPER_ADMIN' && status === 'SUSPENDED') {
        const activeSuperAdministrators = await transaction
          .selectFrom('users')
          .select('id')
          .where('platform_role', '=', 'SUPER_ADMIN')
          .where('status', '=', 'ACTIVE')
          .forUpdate()
          .execute();
        if (activeSuperAdministrators.length <= 1) {
          throw new HttpError(
            409,
            'LAST_SUPER_ADMIN_PROTECTED',
            'The last active super administrator cannot be suspended.',
          );
        }
      }
      const databaseNow = await getDatabaseNow(transaction);
      const updated = await transaction
        .updateTable('users')
        .set({ status, updated_at: databaseNow })
        .where('id', '=', userId)
        .returning(['created_at', 'email', 'id', 'platform_role', 'status', 'updated_at'])
        .executeTakeFirstOrThrow();
      if (status === 'SUSPENDED') await revokeUserSessions(transaction, userId, databaseNow);
      await this.audit(
        transaction,
        actor,
        'platform.user.status_changed',
        userId,
        reason,
        traceId,
        {
          fromStatus: target.status,
          toStatus: status,
        },
      );
      return mapUserSummary(updated);
    });
  }

  public async setPlatformRole(
    actor: UserSessionPrincipal,
    userId: string,
    role: 'ADMIN' | 'USER',
    reason: string,
    traceId: string,
  ): Promise<PlatformUserSummary> {
    return this.database.transaction().execute(async (transaction) => {
      await acquirePlatformAdminMutationLock(transaction);
      const { actorRole, target } = await this.loadMutationActors(transaction, actor, userId);
      if (actorRole !== 'SUPER_ADMIN') {
        throw new HttpError(
          403,
          'SUPER_ADMIN_REQUIRED',
          'Super administrator permission is required.',
        );
      }
      if (target.platform_role === 'SUPER_ADMIN') {
        throw new HttpError(
          409,
          'SUPER_ADMIN_ROLE_PROTECTED',
          'Super administrator roles are not changed through this operation.',
        );
      }
      if (role === 'ADMIN' && target.status !== 'ACTIVE') {
        throw new HttpError(
          409,
          'ADMIN_ACCOUNT_NOT_ACTIVE',
          'Only active accounts can become platform administrators.',
        );
      }
      if (target.platform_role === role) {
        await this.audit(
          transaction,
          actor,
          'platform.user.role_change_requested',
          userId,
          reason,
          traceId,
          { noChange: true, role },
        );
        return mapUserSummary(target);
      }
      const databaseNow = await getDatabaseNow(transaction);
      const updated = await transaction
        .updateTable('users')
        .set({ platform_role: role, updated_at: databaseNow })
        .where('id', '=', userId)
        .returning(['created_at', 'email', 'id', 'platform_role', 'status', 'updated_at'])
        .executeTakeFirstOrThrow();
      await this.audit(transaction, actor, 'platform.user.role_changed', userId, reason, traceId, {
        fromRole: target.platform_role,
        toRole: role,
      });
      return mapUserSummary(updated);
    });
  }

  public async revokeUserSessions(
    actor: UserSessionPrincipal,
    userId: string,
    reason: string,
    traceId: string,
  ): Promise<Readonly<{ revokedFamilies: number }>> {
    return this.database.transaction().execute(async (transaction) => {
      await acquirePlatformAdminMutationLock(transaction);
      const { actorRole, target } = await this.loadMutationActors(transaction, actor, userId);
      assertCanManageTarget(actorRole, target.platform_role);
      const databaseNow = await getDatabaseNow(transaction);
      const revokedFamilies = await revokeUserSessions(transaction, userId, databaseNow);
      await this.audit(
        transaction,
        actor,
        'platform.user.sessions_revoked',
        userId,
        reason,
        traceId,
        { revokedFamilies },
      );
      return { revokedFamilies };
    });
  }

  private async assertPlatformAdministrator(
    database: DeliveryDatabase,
    actor: UserSessionPrincipal,
  ): Promise<PlatformRole> {
    const row = await database
      .selectFrom('users')
      .select(['platform_role', 'status'])
      .where('id', '=', actor.userId)
      .executeTakeFirst();
    if (
      row === undefined ||
      row.status !== 'ACTIVE' ||
      (row.platform_role !== 'ADMIN' && row.platform_role !== 'SUPER_ADMIN')
    ) {
      throw new HttpError(
        403,
        'PLATFORM_ADMIN_REQUIRED',
        'Platform administrator permission is required.',
      );
    }
    return row.platform_role;
  }

  private async loadMutationActors(
    transaction: DeliveryTransaction,
    actor: UserSessionPrincipal,
    targetUserId: string,
  ): Promise<Readonly<{ actorRole: PlatformRole; target: UserRow }>> {
    const users = await transaction
      .selectFrom('users')
      .select(['created_at', 'email', 'id', 'platform_role', 'status', 'updated_at'])
      .where('id', 'in', [...new Set([actor.userId, targetUserId])])
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();
    const platformActor = users.find((user) => user.id === actor.userId);
    if (
      platformActor === undefined ||
      platformActor.status !== 'ACTIVE' ||
      (platformActor.platform_role !== 'ADMIN' && platformActor.platform_role !== 'SUPER_ADMIN')
    ) {
      throw new HttpError(
        403,
        'PLATFORM_ADMIN_REQUIRED',
        'Platform administrator permission is required.',
      );
    }
    const target = users.find((user) => user.id === targetUserId);
    if (target === undefined) throw userNotFound();
    return { actorRole: platformActor.platform_role, target };
  }

  private async selectSessionRows(userId: string): Promise<readonly SessionRow[]> {
    return this.database
      .selectFrom('refresh_sessions')
      .select([
        'created_at',
        'expires_at',
        'family_id',
        'id',
        'ip_address',
        'last_seen_at',
        'organization_id',
        'replaced_by',
        'revoked_at',
        'signing_key_id',
        'used_at',
        'user_agent',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  private async audit(
    transaction: DeliveryTransaction,
    actor: UserSessionPrincipal,
    action: string,
    targetId: string,
    reason: string,
    traceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await transaction
      .insertInto('audit_events')
      .values({
        action,
        actor_id: principalId(actor),
        actor_type: actor.type,
        metadata: { ...principalAuditMetadata(actor), ...metadata, reason },
        organization_id: actor.organizationId,
        project_id: null,
        target_id: targetId,
        target_type: 'USER',
        trace_id: traceId,
      })
      .executeTakeFirstOrThrow();
  }
}

type UserRow = Readonly<{
  created_at: Date;
  email: string;
  id: string;
  platform_role: PlatformRole;
  status: UserStatus;
  updated_at: Date;
}>;

function mapUserSummary(user: UserRow): PlatformUserSummary {
  return {
    createdAt: user.created_at.toISOString(),
    email: user.email,
    id: user.id,
    platformRole: user.platform_role,
    status: user.status,
    updatedAt: user.updated_at.toISOString(),
  };
}

function assertCanManageTarget(actorRole: PlatformRole, targetRole: PlatformRole): void {
  if (actorRole === 'SUPER_ADMIN') return;
  if (actorRole !== 'ADMIN' || targetRole !== 'USER') {
    throw new HttpError(
      403,
      'PLATFORM_USER_MANAGEMENT_DENIED',
      'Platform administrators can manage ordinary users only.',
    );
  }
}

async function revokeUserSessions(
  transaction: DeliveryTransaction,
  userId: string,
  databaseNow: Date,
): Promise<number> {
  const activeFamilies = await transaction
    .selectFrom('refresh_sessions')
    .select('family_id')
    .distinct()
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  if (activeFamilies.length === 0) return 0;
  await transaction
    .updateTable('refresh_sessions')
    .set({ revoked_at: databaseNow })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  return activeFamilies.length;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): Readonly<{ createdAt: string; id: string }> {
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'ADMIN_USER_CURSOR_INVALID', 'The user-list cursor is invalid.');
  }
}

function canonicalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

function userNotFound(): HttpError {
  return new HttpError(404, 'PLATFORM_USER_NOT_FOUND', 'Platform user was not found.');
}
