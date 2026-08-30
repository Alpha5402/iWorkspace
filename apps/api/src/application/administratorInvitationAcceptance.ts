import { randomUUID } from 'node:crypto';

import {
  acquireIdentityEmailLock,
  type DeliveryDatabase,
  getDatabaseNow,
  setTenantContext,
} from '@delivery/database';
import { hashOpaqueToken, hashPassword } from '@delivery/security';

import {
  assertInvitationAcceptable,
  canonicalizeEmail,
  existingUserError,
  invalidInvitationError,
} from './administratorInvitationPolicy.js';
import { administratorInvitationSelection } from './administratorInvitationReadModel.js';
import { failPendingAdministratorInvitationEmails } from './identityEmailDelivery.js';
import { type PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

const ACCEPT_LIMIT = 10;

export async function acceptAdministratorInvitation(
  dependencies: Readonly<{
    database: DeliveryDatabase;
    rateLimiter: PublicAuthRateLimiter;
    tokenPepper: string;
  }>,
  input: Readonly<{ ipAddress: string; password: string; token: string }>,
  traceId: string,
): Promise<Readonly<{ organizationId: string; userId: string }>> {
  await dependencies.rateLimiter.consume({
    identity: input.token,
    identityDimension: 'TOKEN',
    ipAddress: input.ipAddress,
    maximumHits: ACCEPT_LIMIT,
    operation: 'ACCEPT_ADMINISTRATOR_INVITATION',
  });
  const tokenHash = hashOpaqueToken(input.token, dependencies.tokenPepper);
  const [preflight, databaseNow] = await Promise.all([
    dependencies.database
      .selectFrom('administrator_invitations')
      .select(['email', 'expires_at', 'status'])
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst(),
    getDatabaseNow(dependencies.database),
  ]);
  assertInvitationAcceptable(preflight, databaseNow);
  if (preflight === undefined) throw invalidInvitationError();
  const email = canonicalizeEmail(preflight.email);
  const passwordHash = await hashPassword(input.password);

  return dependencies.database.transaction().execute(async (transaction) => {
    const transactionNow = await getDatabaseNow(transaction);
    await acquireIdentityEmailLock(transaction, email);
    const invitation = await transaction
      .selectFrom('administrator_invitations')
      .select(administratorInvitationSelection)
      .where('token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();
    assertInvitationAcceptable(invitation, transactionNow);
    if (invitation === undefined) throw invalidInvitationError();
    if (canonicalizeEmail(invitation.email) !== email) throw invalidInvitationError();
    if (
      (await transaction
        .selectFrom('users')
        .select('id')
        .where('email_canonical', '=', email)
        .executeTakeFirst()) !== undefined
    ) {
      throw existingUserError();
    }

    const user = await transaction
      .insertInto('users')
      .values({ email, platform_role: 'ADMIN', status: 'ACTIVE' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('user_password_credentials')
      .values({ password_hash: passwordHash, user_id: user.id })
      .executeTakeFirstOrThrow();
    const organizationId = randomUUID();
    await setTenantContext(transaction, organizationId);
    await transaction
      .insertInto('organizations')
      .values({ id: organizationId, name: 'Personal Workspace' })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('organization_members')
      .values({ organization_id: organizationId, role: 'OWNER', user_id: user.id })
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('administrator_invitations')
      .set({
        accepted_user_id: user.id,
        consumed_at: transactionNow,
        status: 'ACCEPTED',
        updated_at: transactionNow,
      })
      .where('id', '=', invitation.id)
      .where('status', '=', 'PENDING')
      .executeTakeFirstOrThrow();
    await failPendingAdministratorInvitationEmails(
      transaction,
      invitation.id,
      'INVITATION_CONSUMED',
    );
    await transaction
      .insertInto('audit_events')
      .values({
        action: 'platform.administrator_invitation.accepted',
        actor_id: `administrator-invitation:${invitation.id}`,
        actor_type: 'SYSTEM',
        metadata: { email, subjectUserId: user.id },
        organization_id: organizationId,
        project_id: null,
        target_id: user.id,
        target_type: 'USER',
        trace_id: traceId,
      })
      .executeTakeFirstOrThrow();
    return { organizationId, userId: user.id };
  });
}
