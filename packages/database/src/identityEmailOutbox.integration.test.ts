import { randomUUID } from 'node:crypto';

import { type Insertable } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimIdentityEmailDeliveries } from './identityEmailOutbox.js';
import { createDatabase, type DeliveryDatabase } from './index.js';
import { type IdentityEmailOutboxTable } from './schema.js';

const describeInfrastructure =
  process.env.RUN_INFRA_INTEGRATION === 'true' ? describe : describe.skip;

describeInfrastructure('identity email outbox on PostgreSQL', () => {
  let database: DeliveryDatabase;
  const creatorId = randomUUID();
  const deliveryIds = [randomUUID(), randomUUID()] as const;
  const invitationId = randomUUID();
  const verificationId = randomUUID();
  const verificationUserId = randomUUID();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
    database = createDatabase(databaseUrl);
    await database
      .insertInto('users')
      .values([
        {
          email: `${creatorId}@example.com`,
          id: creatorId,
          platform_role: 'SUPER_ADMIN',
          status: 'ACTIVE',
        },
        {
          email: `${verificationUserId}@example.com`,
          id: verificationUserId,
          platform_role: 'USER',
          status: 'PENDING_VERIFICATION',
        },
      ])
      .execute();
    await database
      .insertInto('email_verification_tokens')
      .values({
        consumed_at: null,
        expires_at: new Date(Date.now() + 60_000),
        id: verificationId,
        superseded_at: null,
        token_hash: 'a'.repeat(64),
        user_id: verificationUserId,
      })
      .execute();
    await database
      .insertInto('administrator_invitations')
      .values({
        accepted_user_id: null,
        consumed_at: null,
        created_by: creatorId,
        email: `${invitationId}@example.com`,
        expires_at: new Date(Date.now() + 60_000),
        id: invitationId,
        idempotency_key: `integration-${invitationId}`,
        request_hash: 'b'.repeat(64),
        revoked_at: null,
        status: 'PENDING',
        target_role: 'ADMIN',
        token_hash: 'c'.repeat(64),
        updated_at: new Date(),
      })
      .execute();
    await database
      .insertInto('identity_email_outbox')
      .values([
        delivery({
          administratorInvitationId: null,
          id: deliveryIds[0],
          messageType: 'VERIFY_EMAIL',
          verificationTokenId: verificationId,
        }),
        delivery({
          administratorInvitationId: invitationId,
          id: deliveryIds[1],
          messageType: 'ADMINISTRATOR_INVITATION',
          verificationTokenId: null,
        }),
      ])
      .execute();
  });

  afterAll(async () => {
    await database.deleteFrom('identity_email_outbox').where('id', 'in', deliveryIds).execute();
    await database.deleteFrom('administrator_invitations').where('id', '=', invitationId).execute();
    await database
      .deleteFrom('email_verification_tokens')
      .where('id', '=', verificationId)
      .execute();
    await database.deleteFrom('users').where('id', 'in', [creatorId, verificationUserId]).execute();
    await database.destroy();
  });

  it('locks only the outbox rows while resolving both nullable credential joins', async () => {
    const claimed = await claimIdentityEmailDeliveries(database, 'integration-email-worker', 2);

    expect(claimed).toHaveLength(2);
    expect(claimed.map((candidate) => candidate.messageType).sort()).toEqual([
      'ADMINISTRATOR_INVITATION',
      'VERIFY_EMAIL',
    ]);
    expect(claimed.every((candidate) => candidate.credentialActive)).toBe(true);
  });
});

function delivery(
  input: Readonly<{
    administratorInvitationId: string | null;
    id: string;
    messageType: 'ADMINISTRATOR_INVITATION' | 'VERIFY_EMAIL';
    verificationTokenId: string | null;
  }>,
): Insertable<IdentityEmailOutboxTable> {
  return {
    aad: `identity-email:${input.id}`,
    administrator_invitation_id: input.administratorInvitationId,
    ciphertext: 'ciphertext',
    claimed_by: null,
    claimed_until: null,
    created_at: new Date(0),
    encrypted_dek: 'encrypted-dek',
    id: input.id,
    iv: 'iv',
    key_version: 1,
    last_error_code: null,
    message_type: input.messageType,
    provider_message_id: null,
    recipient_email: `${input.id}@example.com`,
    sent_at: null,
    tag: 'tag',
    verification_token_id: input.verificationTokenId,
    wrap_iv: 'wrap-iv',
    wrap_tag: 'wrap-tag',
  } as const;
}
