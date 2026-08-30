import { randomUUID } from 'node:crypto';

import {
  acquireIdentityEmailLock,
  acquirePlatformAdminMutationLock,
  type DeliveryDatabase,
  type DeliveryTransaction,
  getDatabaseNow,
} from '@delivery/database';
import {
  issueOpaqueToken,
  principalAuditMetadata,
  principalId,
  type UserSessionPrincipal,
} from '@delivery/security';

import { HttpError } from '../errors.js';
import { acceptAdministratorInvitation } from './administratorInvitationAcceptance.js';
import {
  assertSuperAdministrator,
  canonicalizeEmail,
  existingUserError,
  hashInvitationRequest,
  terminalInvitationError,
} from './administratorInvitationPolicy.js';
import {
  type AdministratorInvitationPage,
  type AdministratorInvitationRow,
  type AdministratorInvitationStatus,
  type AdministratorInvitationSummary,
  administratorInvitationSelection,
  listAdministratorInvitations,
  summarizeAdministratorInvitation,
} from './administratorInvitationReadModel.js';
import {
  enqueueIdentityEmail,
  failPendingAdministratorInvitationEmails,
} from './identityEmailDelivery.js';
import { type PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

const INVITATION_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;

export class AdministratorInvitationService {
  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly administratorDatabase: DeliveryDatabase,
    private readonly tokenPepper: string,
    private readonly emailOutboxKey: Readonly<{ key: Buffer; version: number }>,
    private readonly rateLimiter: PublicAuthRateLimiter,
  ) {}

  public async createInvitation(
    actor: UserSessionPrincipal,
    input: Readonly<{ email: string; idempotencyKey: string; reason: string }>,
    traceId: string,
  ): Promise<Readonly<{ duplicate: boolean; invitation: AdministratorInvitationSummary }>> {
    const email = canonicalizeEmail(input.email);
    const requestHash = hashInvitationRequest({ email, targetRole: 'ADMIN' });
    return this.administratorDatabase.transaction().execute(async (transaction) => {
      await acquirePlatformAdminMutationLock(transaction);
      await assertSuperAdministrator(transaction, actor);
      await acquireIdentityEmailLock(transaction, email);
      const databaseNow = await getDatabaseNow(transaction);
      const idempotent = await transaction
        .selectFrom('administrator_invitations')
        .select(administratorInvitationSelection)
        .where('created_by', '=', actor.userId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (idempotent !== undefined) {
        if (idempotent.request_hash !== requestHash) {
          throw new HttpError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'The idempotency key was already used for a different administrator invitation.',
          );
        }
        return {
          duplicate: true,
          invitation: await summarizeAdministratorInvitation(transaction, idempotent, databaseNow),
        };
      }

      await transaction
        .updateTable('administrator_invitations')
        .set({ status: 'EXPIRED', updated_at: databaseNow })
        .where('email_canonical', '=', email)
        .where('status', '=', 'PENDING')
        .where('expires_at', '<=', databaseNow)
        .execute();
      await this.assertEmailAvailable(transaction, email);
      if (
        (await transaction
          .selectFrom('administrator_invitations')
          .select('id')
          .where('email_canonical', '=', email)
          .where('status', '=', 'PENDING')
          .executeTakeFirst()) !== undefined
      ) {
        throw new HttpError(
          409,
          'ADMINISTRATOR_INVITATION_ALREADY_PENDING',
          'An active administrator invitation already exists for this email.',
        );
      }

      const id = randomUUID();
      const issued = issueOpaqueToken('iwadmin', this.tokenPepper);
      const expiresAt = new Date(databaseNow.getTime() + INVITATION_TTL_MILLISECONDS);
      const invitation = await transaction
        .insertInto('administrator_invitations')
        .values({
          accepted_user_id: null,
          consumed_at: null,
          created_by: actor.userId,
          email,
          expires_at: expiresAt,
          id,
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          revoked_at: null,
          status: 'PENDING',
          target_role: 'ADMIN',
          token_hash: issued.hash,
          updated_at: databaseNow,
        })
        .returning(administratorInvitationSelection)
        .executeTakeFirstOrThrow();
      await this.enqueueInvitationEmail(transaction, invitation.id, email, issued.token);
      await this.auditAdministratorAction(
        transaction,
        actor,
        'platform.administrator_invitation.created',
        id,
        input.reason,
        traceId,
        { email, expiresAt: expiresAt.toISOString(), targetRole: 'ADMIN' },
      );
      return {
        duplicate: false,
        invitation: await summarizeAdministratorInvitation(transaction, invitation, databaseNow),
      };
    });
  }

  public listInvitations(
    actor: UserSessionPrincipal,
    input: Readonly<{
      cursor?: string | undefined;
      limit: number;
      status?: AdministratorInvitationStatus | undefined;
    }>,
  ): Promise<AdministratorInvitationPage> {
    return listAdministratorInvitations(this.administratorDatabase, actor, input);
  }

  public async resendInvitation(
    actor: UserSessionPrincipal,
    invitationId: string,
    reason: string,
    traceId: string,
  ): Promise<AdministratorInvitationSummary> {
    return this.administratorDatabase.transaction().execute(async (transaction) => {
      await acquirePlatformAdminMutationLock(transaction);
      await assertSuperAdministrator(transaction, actor);
      const email = await this.loadEmailForMutation(transaction, invitationId);
      await acquireIdentityEmailLock(transaction, email);
      const invitation = await this.loadForMutation(transaction, invitationId);
      if (invitation.status === 'ACCEPTED' || invitation.status === 'REVOKED') {
        throw terminalInvitationError();
      }
      await this.assertEmailAvailable(transaction, email);
      const databaseNow = await getDatabaseNow(transaction);
      const issued = issueOpaqueToken('iwadmin', this.tokenPepper);
      const expiresAt = new Date(databaseNow.getTime() + INVITATION_TTL_MILLISECONDS);
      await failPendingAdministratorInvitationEmails(
        transaction,
        invitation.id,
        'INVITATION_SUPERSEDED',
      );
      const updated = await transaction
        .updateTable('administrator_invitations')
        .set({
          expires_at: expiresAt,
          status: 'PENDING',
          token_hash: issued.hash,
          updated_at: databaseNow,
        })
        .where('id', '=', invitation.id)
        .where('status', 'in', ['PENDING', 'EXPIRED'])
        .returning(administratorInvitationSelection)
        .executeTakeFirstOrThrow();
      await this.enqueueInvitationEmail(transaction, invitation.id, invitation.email, issued.token);
      await this.auditAdministratorAction(
        transaction,
        actor,
        'platform.administrator_invitation.resent',
        invitation.id,
        reason,
        traceId,
        { expiresAt: expiresAt.toISOString() },
      );
      return summarizeAdministratorInvitation(transaction, updated, databaseNow);
    });
  }

  public async revokeInvitation(
    actor: UserSessionPrincipal,
    invitationId: string,
    reason: string,
    traceId: string,
  ): Promise<AdministratorInvitationSummary> {
    return this.administratorDatabase.transaction().execute(async (transaction) => {
      await acquirePlatformAdminMutationLock(transaction);
      await assertSuperAdministrator(transaction, actor);
      const email = await this.loadEmailForMutation(transaction, invitationId);
      await acquireIdentityEmailLock(transaction, email);
      const invitation = await this.loadForMutation(transaction, invitationId);
      const databaseNow = await getDatabaseNow(transaction);
      if (invitation.status === 'ACCEPTED') throw terminalInvitationError();
      if (invitation.status === 'REVOKED') {
        await this.auditAdministratorAction(
          transaction,
          actor,
          'platform.administrator_invitation.revoke_requested',
          invitation.id,
          reason,
          traceId,
          { noChange: true },
        );
        return summarizeAdministratorInvitation(transaction, invitation, databaseNow);
      }
      await failPendingAdministratorInvitationEmails(
        transaction,
        invitation.id,
        'INVITATION_REVOKED',
      );
      const updated = await transaction
        .updateTable('administrator_invitations')
        .set({ revoked_at: databaseNow, status: 'REVOKED', updated_at: databaseNow })
        .where('id', '=', invitation.id)
        .where('status', 'in', ['PENDING', 'EXPIRED'])
        .returning(administratorInvitationSelection)
        .executeTakeFirstOrThrow();
      await this.auditAdministratorAction(
        transaction,
        actor,
        'platform.administrator_invitation.revoked',
        invitation.id,
        reason,
        traceId,
        {},
      );
      return summarizeAdministratorInvitation(transaction, updated, databaseNow);
    });
  }

  public acceptInvitation(
    input: Readonly<{ ipAddress: string; password: string; token: string }>,
    traceId: string,
  ): Promise<Readonly<{ organizationId: string; userId: string }>> {
    return acceptAdministratorInvitation(
      { database: this.database, rateLimiter: this.rateLimiter, tokenPepper: this.tokenPepper },
      input,
      traceId,
    );
  }

  private async loadForMutation(
    transaction: DeliveryTransaction,
    invitationId: string,
  ): Promise<AdministratorInvitationRow> {
    const invitation = await transaction
      .selectFrom('administrator_invitations')
      .select(administratorInvitationSelection)
      .where('id', '=', invitationId)
      .forUpdate()
      .executeTakeFirst();
    if (invitation === undefined) {
      throw new HttpError(
        404,
        'ADMINISTRATOR_INVITATION_NOT_FOUND',
        'Administrator invitation was not found.',
      );
    }
    return invitation;
  }

  private async loadEmailForMutation(
    transaction: DeliveryTransaction,
    invitationId: string,
  ): Promise<string> {
    const invitation = await transaction
      .selectFrom('administrator_invitations')
      .select('email')
      .where('id', '=', invitationId)
      .executeTakeFirst();
    if (invitation === undefined) {
      throw new HttpError(
        404,
        'ADMINISTRATOR_INVITATION_NOT_FOUND',
        'Administrator invitation was not found.',
      );
    }
    return canonicalizeEmail(invitation.email);
  }

  private async assertEmailAvailable(
    transaction: DeliveryTransaction,
    email: string,
  ): Promise<void> {
    if (
      (await transaction
        .selectFrom('users')
        .select('id')
        .where('email_canonical', '=', email)
        .executeTakeFirst()) !== undefined
    ) {
      throw existingUserError();
    }
  }

  private async enqueueInvitationEmail(
    transaction: DeliveryTransaction,
    invitationId: string,
    email: string,
    token: string,
  ): Promise<void> {
    await enqueueIdentityEmail(transaction, {
      encryptionKey: this.emailOutboxKey,
      plaintextToken: token,
      recipientEmail: email,
      target: {
        administratorInvitationId: invitationId,
        messageType: 'ADMINISTRATOR_INVITATION',
      },
    });
  }

  private async auditAdministratorAction(
    transaction: DeliveryTransaction,
    actor: UserSessionPrincipal,
    action: string,
    invitationId: string,
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
        target_id: invitationId,
        target_type: 'ADMINISTRATOR_INVITATION',
        trace_id: traceId,
      })
      .executeTakeFirstOrThrow();
  }
}
