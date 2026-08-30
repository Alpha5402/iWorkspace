import { randomUUID } from 'node:crypto';

import {
  acquireIdentityEmailLock,
  type DeliveryDatabase,
  type DeliveryTransaction,
  getDatabaseNow,
  setTenantContext,
} from '@delivery/database';
import { hashOpaqueToken, hashPassword, issueOpaqueToken } from '@delivery/security';
import { HttpError } from '../errors.js';
import { enqueueIdentityEmail } from './identityEmailDelivery.js';
import { type PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

const VERIFICATION_TTL_MILLISECONDS = 30 * 60 * 1_000;
const REGISTRATION_LIMIT = 5;
const RESEND_LIMIT = 3;

export type PublicRegistrationResult = Readonly<{ accepted: true }>;

export class RegistrationService {
  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly tokenPepper: string,
    private readonly emailOutboxKey: Readonly<{ key: Buffer; version: number }>,
    private readonly rateLimiter: PublicAuthRateLimiter,
  ) {}

  public async register(
    input: Readonly<{ email: string; ipAddress: string; password: string }>,
  ): Promise<PublicRegistrationResult> {
    const email = canonicalizeEmail(input.email);
    await this.rateLimiter.consume({
      identity: email,
      identityDimension: 'EMAIL',
      ipAddress: input.ipAddress,
      maximumHits: REGISTRATION_LIMIT,
      operation: 'REGISTER',
    });
    const passwordHash = await hashPassword(input.password);

    return this.database.transaction().execute(async (transaction) => {
      await acquireIdentityEmailLock(transaction, email);
      const databaseNow = await getDatabaseNow(transaction);
      const administratorInvitation = await transaction
        .selectFrom('administrator_invitations')
        .select('id')
        .where('email_canonical', '=', email)
        .where('status', '=', 'PENDING')
        .where('expires_at', '>', databaseNow)
        .executeTakeFirst();
      if (administratorInvitation !== undefined) return { accepted: true };
      const user = await transaction
        .insertInto('users')
        .values({ email, platform_role: 'USER', status: 'PENDING_VERIFICATION' })
        .onConflict((conflict) => conflict.column('email_canonical').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (user === undefined) return { accepted: true };

      await transaction
        .insertInto('user_password_credentials')
        .values({ password_hash: passwordHash, user_id: user.id })
        .executeTakeFirstOrThrow();
      await this.enqueueVerification(transaction, user.id, email);
      return { accepted: true };
    });
  }

  public async resendVerification(
    input: Readonly<{ email: string; ipAddress: string }>,
  ): Promise<PublicRegistrationResult> {
    const email = canonicalizeEmail(input.email);
    await this.rateLimiter.consume({
      identity: email,
      identityDimension: 'EMAIL',
      ipAddress: input.ipAddress,
      maximumHits: RESEND_LIMIT,
      operation: 'RESEND_VERIFICATION',
    });

    return this.database.transaction().execute(async (transaction) => {
      const databaseNow = await getDatabaseNow(transaction);
      const user = await transaction
        .selectFrom('users')
        .select(['id', 'status'])
        .where('email_canonical', '=', email)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined || user.status !== 'PENDING_VERIFICATION') {
        return { accepted: true };
      }
      await transaction
        .updateTable('email_verification_tokens')
        .set({ superseded_at: databaseNow })
        .where('user_id', '=', user.id)
        .where('consumed_at', 'is', null)
        .where('superseded_at', 'is', null)
        .execute();
      await transaction
        .updateTable('identity_email_outbox')
        .set({ last_error_code: 'VERIFICATION_SUPERSEDED', status: 'FAILED' })
        .where('verification_token_id', 'in', (query) =>
          query
            .selectFrom('email_verification_tokens')
            .select('id')
            .where('user_id', '=', user.id)
            .where('superseded_at', 'is not', null),
        )
        .where('status', 'in', ['PENDING', 'RETRY_WAIT'])
        .execute();
      await this.enqueueVerification(transaction, user.id, email);
      return { accepted: true };
    });
  }

  public async verifyEmail(token: string): Promise<Readonly<{ organizationId: string }>> {
    const tokenHash = hashOpaqueToken(token, this.tokenPepper);
    return this.database.transaction().execute(async (transaction) => {
      const databaseNow = await getDatabaseNow(transaction);
      const verification = await transaction
        .selectFrom('email_verification_tokens')
        .innerJoin('users', 'users.id', 'email_verification_tokens.user_id')
        .select([
          'email_verification_tokens.id',
          'email_verification_tokens.consumed_at',
          'email_verification_tokens.expires_at',
          'email_verification_tokens.superseded_at',
          'users.id as user_id',
          'users.status',
        ])
        .where('email_verification_tokens.token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (
        verification === undefined ||
        verification.consumed_at !== null ||
        verification.superseded_at !== null ||
        verification.status !== 'PENDING_VERIFICATION'
      ) {
        throw new HttpError(
          400,
          'VERIFICATION_TOKEN_INVALID',
          'Email verification token is invalid.',
        );
      }
      if (verification.expires_at <= databaseNow) {
        throw new HttpError(
          410,
          'VERIFICATION_TOKEN_EXPIRED',
          'Email verification token has expired.',
        );
      }

      const organizationId = randomUUID();
      await setTenantContext(transaction, organizationId);
      await transaction
        .insertInto('organizations')
        .values({ id: organizationId, name: 'Personal Workspace' })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('organization_members')
        .values({ organization_id: organizationId, role: 'OWNER', user_id: verification.user_id })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('users')
        .set({ status: 'ACTIVE', updated_at: databaseNow })
        .where('id', '=', verification.user_id)
        .where('status', '=', 'PENDING_VERIFICATION')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('email_verification_tokens')
        .set({ consumed_at: databaseNow })
        .where('id', '=', verification.id)
        .where('consumed_at', 'is', null)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('identity_email_outbox')
        .set({ last_error_code: 'VERIFICATION_CONSUMED', status: 'FAILED' })
        .where('verification_token_id', '=', verification.id)
        .where('status', 'in', ['PENDING', 'RETRY_WAIT'])
        .execute();
      return { organizationId };
    });
  }

  private async enqueueVerification(
    transaction: DeliveryTransaction,
    userId: string,
    email: string,
  ): Promise<void> {
    const verificationId = randomUUID();
    const issued = issueOpaqueToken('iwverify', this.tokenPepper);
    const databaseNow = await getDatabaseNow(transaction);
    await transaction
      .insertInto('email_verification_tokens')
      .values({
        consumed_at: null,
        expires_at: new Date(databaseNow.getTime() + VERIFICATION_TTL_MILLISECONDS),
        id: verificationId,
        superseded_at: null,
        token_hash: issued.hash,
        user_id: userId,
      })
      .executeTakeFirstOrThrow();
    await enqueueIdentityEmail(transaction, {
      encryptionKey: this.emailOutboxKey,
      plaintextToken: issued.token,
      recipientEmail: email,
      target: { messageType: 'VERIFY_EMAIL', verificationTokenId: verificationId },
    });
  }
}

function canonicalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}
