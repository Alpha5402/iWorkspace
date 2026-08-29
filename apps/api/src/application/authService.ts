import { randomBytes, randomUUID } from 'node:crypto';

import { type DeliveryDatabase } from '@delivery/database';
import {
  type AccessTokenService,
  hashOpaqueToken,
  hashPassword,
  issueOpaqueToken,
  verifyPassword,
} from '@delivery/security';

import { HttpError } from '../errors.js';

export type UserActor = Readonly<{
  organizationId: string;
  sessionId: string;
  type: 'USER';
  userId: string;
}>;

export type SessionBundle = Readonly<{
  accessToken: string;
  csrfToken: string;
  refreshToken: string;
  user: Readonly<{ email: string; id: string; organizationId: string; organizationRole: string }>;
}>;

const REFRESH_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

export class AuthService {
  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly accessTokens: AccessTokenService,
    private readonly tokenPepper: string,
  ) {}

  public async login(
    input: Readonly<{ email: string; organizationId?: string | undefined; password: string }>,
  ): Promise<SessionBundle> {
    const credential = await this.database
      .selectFrom('users')
      .innerJoin('user_password_credentials', 'user_password_credentials.user_id', 'users.id')
      .select([
        'users.id',
        'users.email',
        'users.status',
        'user_password_credentials.password_hash',
      ])
      .where('users.email_canonical', '=', input.email.trim().toLocaleLowerCase())
      .executeTakeFirst();
    if (
      credential === undefined ||
      credential.status !== 'ACTIVE' ||
      !(await verifyPassword(credential.password_hash, input.password))
    ) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    let membershipQuery = this.database
      .selectFrom('organization_members')
      .select(['organization_id', 'role'])
      .where('user_id', '=', credential.id);
    if (input.organizationId !== undefined) {
      membershipQuery = membershipQuery.where('organization_id', '=', input.organizationId);
    }
    const membership = await membershipQuery.orderBy('created_at', 'asc').executeTakeFirst();
    if (membership === undefined) {
      throw new HttpError(
        403,
        'ORGANIZATION_ACCESS_DENIED',
        'No accessible organization was found.',
      );
    }
    return this.createSession({
      email: credential.email,
      organizationId: membership.organization_id,
      organizationRole: membership.role,
      userId: credential.id,
    });
  }

  public async refresh(refreshToken: string): Promise<SessionBundle> {
    const tokenHash = hashOpaqueToken(refreshToken, this.tokenPepper);
    const result = await this.database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom('refresh_sessions')
        .innerJoin('users', 'users.id', 'refresh_sessions.user_id')
        .innerJoin('organization_members', (join) =>
          join
            .onRef('organization_members.user_id', '=', 'refresh_sessions.user_id')
            .onRef('organization_members.organization_id', '=', 'refresh_sessions.organization_id'),
        )
        .select([
          'refresh_sessions.id',
          'refresh_sessions.family_id',
          'refresh_sessions.user_id',
          'refresh_sessions.organization_id',
          'refresh_sessions.expires_at',
          'refresh_sessions.used_at',
          'refresh_sessions.revoked_at',
          'users.email',
          'users.status',
          'organization_members.role',
        ])
        .where('refresh_sessions.token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) {
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid.');
      }
      if (session.used_at !== null) {
        await transaction
          .updateTable('refresh_sessions')
          .set({ revoked_at: new Date() })
          .where('family_id', '=', session.family_id)
          .where('revoked_at', 'is', null)
          .execute();
        return { refreshReuseDetected: true } as const;
      }
      if (
        session.revoked_at !== null ||
        session.expires_at <= new Date() ||
        session.status !== 'ACTIVE'
      ) {
        throw new HttpError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token is no longer active.');
      }
      const nextSessionId = randomUUID();
      const issued = issueOpaqueToken('iwrf', this.tokenPepper);
      const expiresAt = new Date(Date.now() + REFRESH_TTL_MILLISECONDS);
      await transaction
        .insertInto('refresh_sessions')
        .values({
          expires_at: expiresAt,
          family_id: session.family_id,
          id: nextSessionId,
          organization_id: session.organization_id,
          replaced_by: null,
          revoked_at: null,
          token_hash: issued.hash,
          used_at: null,
          user_id: session.user_id,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('refresh_sessions')
        .set({ replaced_by: nextSessionId, used_at: new Date() })
        .where('id', '=', session.id)
        .executeTakeFirstOrThrow();
      return {
        accessToken: await this.accessTokens.issue({
          organizationId: session.organization_id,
          sessionId: nextSessionId,
          sub: session.user_id,
        }),
        csrfToken: randomBytes(24).toString('base64url'),
        refreshToken: issued.token,
        user: {
          email: session.email,
          id: session.user_id,
          organizationId: session.organization_id,
          organizationRole: session.role,
        },
      };
    });
    if ('refreshReuseDetected' in result) {
      throw new HttpError(
        401,
        'REFRESH_TOKEN_REUSED',
        'Refresh token reuse revoked the session family.',
      );
    }
    return result;
  }

  public async logout(actor: UserActor): Promise<void> {
    const session = await this.database
      .selectFrom('refresh_sessions')
      .select('family_id')
      .where('id', '=', actor.sessionId)
      .where('user_id', '=', actor.userId)
      .executeTakeFirst();
    if (session === undefined) return;
    await this.database
      .updateTable('refresh_sessions')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', session.family_id)
      .where('revoked_at', 'is', null)
      .execute();
  }

  public async acceptInvitation(
    input: Readonly<{
      password: string;
      token: string;
    }>,
  ): Promise<Readonly<{ organizationId: string }>> {
    const tokenHash = hashOpaqueToken(input.token, this.tokenPepper);
    return this.database.transaction().execute(async (transaction) => {
      const invitation = await transaction
        .selectFrom('invitations')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (
        invitation === undefined ||
        invitation.accepted_at !== null ||
        invitation.expires_at <= new Date()
      ) {
        throw new HttpError(410, 'INVITATION_INVALID', 'Invitation is invalid or expired.');
      }
      let user = await transaction
        .selectFrom('users')
        .select('id')
        .where('email_canonical', '=', invitation.email_canonical)
        .executeTakeFirst();
      if (user === undefined) {
        user = await transaction
          .insertInto('users')
          .values({ email: invitation.email_canonical, status: 'ACTIVE' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('user_password_credentials')
          .values({ password_hash: await hashPassword(input.password), user_id: user.id })
          .executeTakeFirstOrThrow();
      }
      await transaction
        .insertInto('organization_members')
        .values({
          organization_id: invitation.organization_id,
          role: invitation.organization_role,
          user_id: user.id,
        })
        .onConflict((conflict) => conflict.columns(['organization_id', 'user_id']).doNothing())
        .executeTakeFirst();
      await transaction
        .updateTable('invitations')
        .set({ accepted_at: new Date() })
        .where('id', '=', invitation.id)
        .where('accepted_at', 'is', null)
        .executeTakeFirstOrThrow();
      return { organizationId: invitation.organization_id };
    });
  }

  public verifyAccessToken(token: string): Promise<UserActor> {
    return this.accessTokens.verify(token).then((claims) => ({
      organizationId: claims.organizationId,
      sessionId: claims.sessionId,
      type: 'USER' as const,
      userId: claims.sub,
    }));
  }

  private async createSession(
    user: Readonly<{
      email: string;
      organizationId: string;
      organizationRole: string;
      userId: string;
    }>,
  ): Promise<SessionBundle> {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const refresh = issueOpaqueToken('iwrf', this.tokenPepper);
    await this.database
      .insertInto('refresh_sessions')
      .values({
        expires_at: new Date(Date.now() + REFRESH_TTL_MILLISECONDS),
        family_id: familyId,
        id: sessionId,
        organization_id: user.organizationId,
        replaced_by: null,
        revoked_at: null,
        token_hash: refresh.hash,
        used_at: null,
        user_id: user.userId,
      })
      .executeTakeFirstOrThrow();
    return {
      accessToken: await this.accessTokens.issue({
        organizationId: user.organizationId,
        sessionId,
        sub: user.userId,
      }),
      csrfToken: randomBytes(24).toString('base64url'),
      refreshToken: refresh.token,
      user: {
        email: user.email,
        id: user.userId,
        organizationId: user.organizationId,
        organizationRole: user.organizationRole,
      },
    };
  }
}

export async function bootstrapFirstAdmin(
  input: Readonly<{
    database: DeliveryDatabase;
    email: string;
    organizationName: string;
    password: string;
  }>,
): Promise<Readonly<{ organizationId: string; userId: string }>> {
  return input.database.transaction().execute(async (transaction) => {
    const existing = await transaction.selectFrom('users').select('id').limit(1).executeTakeFirst();
    if (existing !== undefined) {
      throw new Error('BOOTSTRAP_ALREADY_COMPLETED');
    }
    const user = await transaction
      .insertInto('users')
      .values({ email: input.email, status: 'ACTIVE' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('user_password_credentials')
      .values({ password_hash: await hashPassword(input.password), user_id: user.id })
      .executeTakeFirstOrThrow();
    const organization = await transaction
      .insertInto('organizations')
      .values({ name: input.organizationName })
      .returning('id')
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('organization_members')
      .values({ organization_id: organization.id, role: 'OWNER', user_id: user.id })
      .executeTakeFirstOrThrow();
    return { organizationId: organization.id, userId: user.id };
  });
}
