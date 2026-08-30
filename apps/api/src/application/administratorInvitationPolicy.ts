import { createHash } from 'node:crypto';

import { type DeliveryDatabase, type DeliveryTransaction } from '@delivery/database';
import { type UserSessionPrincipal } from '@delivery/security';

import { HttpError } from '../errors.js';

export type AdministratorInvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export async function assertPlatformAdministrator(
  database: DeliveryDatabase | DeliveryTransaction,
  actor: UserSessionPrincipal,
): Promise<'ADMIN' | 'SUPER_ADMIN'> {
  const user = await database
    .selectFrom('users')
    .select(['platform_role', 'status'])
    .where('id', '=', actor.userId)
    .executeTakeFirst();
  if (
    user === undefined ||
    user.status !== 'ACTIVE' ||
    (user.platform_role !== 'ADMIN' && user.platform_role !== 'SUPER_ADMIN')
  ) {
    throw new HttpError(
      403,
      'PLATFORM_ADMIN_REQUIRED',
      'Platform administrator permission is required.',
    );
  }
  return user.platform_role;
}

export async function assertSuperAdministrator(
  database: DeliveryDatabase | DeliveryTransaction,
  actor: UserSessionPrincipal,
): Promise<void> {
  if ((await assertPlatformAdministrator(database, actor)) !== 'SUPER_ADMIN') {
    throw new HttpError(403, 'SUPER_ADMIN_REQUIRED', 'Super administrator permission is required.');
  }
}

export function assertInvitationAcceptable(
  invitation: Readonly<{ expires_at: Date; status: AdministratorInvitationStatus }> | undefined,
  databaseNow: Date,
): void {
  if (invitation === undefined || invitation.status !== 'PENDING') throw invalidInvitationError();
  if (invitation.expires_at <= databaseNow) {
    throw new HttpError(
      410,
      'ADMINISTRATOR_INVITATION_EXPIRED',
      'Administrator invitation has expired.',
    );
  }
}

export function invalidInvitationError(): HttpError {
  return new HttpError(
    400,
    'ADMINISTRATOR_INVITATION_INVALID',
    'Administrator invitation is invalid.',
  );
}

export function terminalInvitationError(): HttpError {
  return new HttpError(
    409,
    'ADMINISTRATOR_INVITATION_TERMINAL',
    'Accepted or revoked administrator invitations cannot be changed.',
  );
}

export function existingUserError(): HttpError {
  return new HttpError(
    409,
    'PLATFORM_USER_ALREADY_EXISTS',
    'This email already belongs to a platform user; grant ADMIN from the existing user detail.',
  );
}

export function canonicalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

export function hashInvitationRequest(request: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
