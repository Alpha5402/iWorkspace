import { randomBytes, randomUUID } from 'node:crypto';

import { type DeliveryDatabase } from '@delivery/database';
import {
  type AccessTokenService,
  hashOpaqueToken,
  hashPassword,
  type RefreshTokenClaims,
  type RefreshTokenService,
  verifyPassword,
} from '@delivery/security';

import { HttpError } from '../errors.js';
import { type PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

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
    private readonly refreshTokens: RefreshTokenService,
    private readonly tokenPepper: string,
    private readonly rateLimiter: PublicAuthRateLimiter,
  ) {}

  public async login(
    input: Readonly<{
      email: string;
      ipAddress: string;
      organizationId?: string | undefined;
      password: string;
    }>,
  ): Promise<SessionBundle> {
    await this.rateLimiter.consume({
      email: input.email,
      ipAddress: input.ipAddress,
      maximumHits: 10,
      operation: 'LOGIN',
    });
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
    let claims: RefreshTokenClaims;
    try {
      claims = await this.refreshTokens.verify(refreshToken);
    } catch {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid.');
    }
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
          'refresh_sessions.signing_key_id',
          'refresh_sessions.token_jti',
          'refresh_sessions.expires_at',
          'refresh_sessions.used_at',
          'refresh_sessions.revoked_at',
          'users.email',
          'users.status',
          'organization_members.role',
        ])
        .where('refresh_sessions.id', '=', claims.sessionId)
        .where('refresh_sessions.token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) {
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid.');
      }
      if (
        session.family_id !== claims.familyId ||
        session.organization_id !== claims.organizationId ||
        session.token_jti !== claims.jti ||
        session.user_id !== claims.sub
      ) {
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
      const nextTokenJti = randomUUID();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + REFRESH_TTL_MILLISECONDS);
      const nextRefreshToken = await this.refreshTokens.issue(
        {
          familyId: session.family_id,
          jti: nextTokenJti,
          organizationId: session.organization_id,
          sessionId: nextSessionId,
          sub: session.user_id,
        },
        issuedAt,
      );
      await transaction
        .insertInto('refresh_sessions')
        .values({
          expires_at: expiresAt,
          family_id: session.family_id,
          id: nextSessionId,
          organization_id: session.organization_id,
          replaced_by: null,
          revoked_at: null,
          signing_key_id: this.refreshTokens.signingKeyId,
          token_hash: hashOpaqueToken(nextRefreshToken, this.tokenPepper),
          token_jti: nextTokenJti,
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
        refreshToken: nextRefreshToken,
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
        .select(['id', 'status'])
        .where('email_canonical', '=', invitation.email_canonical)
        .executeTakeFirst();
      if (user === undefined) {
        user = await transaction
          .insertInto('users')
          .values({ email: invitation.email_canonical, status: 'ACTIVE' })
          .returning(['id', 'status'])
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('user_password_credentials')
          .values({ password_hash: await hashPassword(input.password), user_id: user.id })
          .executeTakeFirstOrThrow();
      }
      if (user.status !== 'ACTIVE') {
        throw new HttpError(
          409,
          'EMAIL_VERIFICATION_REQUIRED',
          'The account must complete email verification before joining an organization.',
        );
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

  public async verifyAccessToken(token: string): Promise<UserActor> {
    const claims = await this.accessTokens.verify(token);
    const activeSession = await this.database
      .selectFrom('refresh_sessions')
      .innerJoin('users', 'users.id', 'refresh_sessions.user_id')
      .innerJoin('organization_members', (join) =>
        join
          .onRef('organization_members.user_id', '=', 'refresh_sessions.user_id')
          .onRef('organization_members.organization_id', '=', 'refresh_sessions.organization_id'),
      )
      .select('refresh_sessions.id')
      .where('refresh_sessions.id', '=', claims.sessionId)
      .where('refresh_sessions.user_id', '=', claims.sub)
      .where('refresh_sessions.organization_id', '=', claims.organizationId)
      .where('refresh_sessions.revoked_at', 'is', null)
      .where('refresh_sessions.expires_at', '>', new Date())
      .where('users.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (activeSession === undefined) {
      throw new HttpError(401, 'ACCESS_SESSION_INACTIVE', 'Access session is no longer active.');
    }
    return {
      organizationId: claims.organizationId,
      sessionId: claims.sessionId,
      type: 'USER' as const,
      userId: claims.sub,
    };
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
    const tokenJti = randomUUID();
    const issuedAt = new Date();
    const refreshToken = await this.refreshTokens.issue(
      {
        familyId,
        jti: tokenJti,
        organizationId: user.organizationId,
        sessionId,
        sub: user.userId,
      },
      issuedAt,
    );
    await this.database
      .insertInto('refresh_sessions')
      .values({
        expires_at: new Date(issuedAt.getTime() + REFRESH_TTL_MILLISECONDS),
        family_id: familyId,
        id: sessionId,
        organization_id: user.organizationId,
        replaced_by: null,
        revoked_at: null,
        signing_key_id: this.refreshTokens.signingKeyId,
        token_hash: hashOpaqueToken(refreshToken, this.tokenPepper),
        token_jti: tokenJti,
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
      refreshToken,
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
      .values({ email: input.email, platform_role: 'SUPER_ADMIN', status: 'ACTIVE' })
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
