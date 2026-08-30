import {
  type DeliveryDatabase,
  type DeliveryTransaction,
  getDatabaseNow,
} from '@delivery/database';
import { type UserSessionPrincipal } from '@delivery/security';
import { z } from 'zod';

import { HttpError } from '../errors.js';
import {
  assertPlatformAdministrator,
  type AdministratorInvitationStatus,
} from './administratorInvitationPolicy.js';

export type { AdministratorInvitationStatus } from './administratorInvitationPolicy.js';

const CursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

export type AdministratorInvitationSummary = Readonly<{
  acceptedAt?: string;
  acceptedUserId?: string;
  createdAt: string;
  createdBy: string;
  delivery: Readonly<{
    errorCode?: string;
    sentAt?: string;
    status: 'PENDING' | 'CLAIMED' | 'RETRY_WAIT' | 'SENT' | 'FAILED';
  }>;
  email: string;
  expiresAt: string;
  id: string;
  revokedAt?: string;
  status: AdministratorInvitationStatus;
  targetRole: 'ADMIN';
}>;

export type AdministratorInvitationPage = Readonly<{
  invitations: readonly AdministratorInvitationSummary[];
  nextCursor?: string;
}>;

export type AdministratorInvitationRow = Readonly<{
  accepted_user_id: string | null;
  consumed_at: Date | null;
  created_at: Date;
  created_by: string;
  email: string;
  expires_at: Date;
  id: string;
  request_hash: string;
  revoked_at: Date | null;
  status: AdministratorInvitationStatus;
  target_role: 'ADMIN';
  updated_at: Date;
}>;

export const administratorInvitationSelection = [
  'accepted_user_id',
  'consumed_at',
  'created_at',
  'created_by',
  'email',
  'expires_at',
  'id',
  'request_hash',
  'revoked_at',
  'status',
  'target_role',
  'updated_at',
] as const;

export async function listAdministratorInvitations(
  database: DeliveryDatabase,
  actor: UserSessionPrincipal,
  input: Readonly<{
    cursor?: string | undefined;
    limit: number;
    status?: AdministratorInvitationStatus | undefined;
  }>,
): Promise<AdministratorInvitationPage> {
  await assertPlatformAdministrator(database, actor);
  const databaseNow = await getDatabaseNow(database);
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  let query = database
    .selectFrom('administrator_invitations')
    .select(administratorInvitationSelection);
  if (input.status === 'EXPIRED') {
    query = query.where('status', '=', 'PENDING').where('expires_at', '<=', databaseNow);
  } else if (input.status === 'PENDING') {
    query = query.where('status', '=', 'PENDING').where('expires_at', '>', databaseNow);
  } else if (input.status !== undefined) {
    query = query.where('status', '=', input.status);
  }
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
  const invitations = await Promise.all(
    pageRows.map((row) => summarizeAdministratorInvitation(database, row, databaseNow)),
  );
  const last = pageRows.at(-1);
  return {
    invitations,
    ...(rows.length > input.limit && last !== undefined
      ? { nextCursor: encodeCursor(last.created_at, last.id) }
      : {}),
  };
}

export async function summarizeAdministratorInvitation(
  database: DeliveryDatabase | DeliveryTransaction,
  invitation: AdministratorInvitationRow,
  databaseNow: Date,
): Promise<AdministratorInvitationSummary> {
  const delivery = await database
    .selectFrom('identity_email_outbox')
    .select(['last_error_code', 'sent_at', 'status'])
    .where('administrator_invitation_id', '=', invitation.id)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  return {
    ...(invitation.consumed_at === null
      ? {}
      : { acceptedAt: invitation.consumed_at.toISOString() }),
    ...(invitation.accepted_user_id === null
      ? {}
      : { acceptedUserId: invitation.accepted_user_id }),
    createdAt: invitation.created_at.toISOString(),
    createdBy: invitation.created_by,
    delivery: {
      ...(delivery.last_error_code === null ? {} : { errorCode: delivery.last_error_code }),
      ...(delivery.sent_at === null ? {} : { sentAt: delivery.sent_at.toISOString() }),
      status: delivery.status,
    },
    email: invitation.email,
    expiresAt: invitation.expires_at.toISOString(),
    id: invitation.id,
    ...(invitation.revoked_at === null ? {} : { revokedAt: invitation.revoked_at.toISOString() }),
    status:
      invitation.status === 'PENDING' && invitation.expires_at <= databaseNow
        ? 'EXPIRED'
        : invitation.status,
    targetRole: invitation.target_role,
  };
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
    throw new HttpError(
      400,
      'ADMINISTRATOR_INVITATION_CURSOR_INVALID',
      'The administrator-invitation cursor is invalid.',
    );
  }
}
