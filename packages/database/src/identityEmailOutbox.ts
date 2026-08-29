import { type Kysely, sql } from 'kysely';

import { getDatabaseNow } from './databaseClock.js';
import { type DatabaseSchema } from './schema.js';

type DeliveryDatabase = Kysely<DatabaseSchema>;

export type ClaimedIdentityEmail = Readonly<{
  aad: string;
  attemptCount: number;
  ciphertext: string;
  encryptedDek: string;
  id: string;
  iv: string;
  keyVersion: number;
  maxAttempts: number;
  recipientEmail: string;
  tag: string;
  verificationTokenId: string;
  verificationTokenActive: boolean;
  wrapIv: string;
  wrapTag: string;
}>;

export async function claimIdentityEmailDeliveries(
  database: DeliveryDatabase,
  workerId: string,
  batchSize: number,
  claimSeconds = 30,
): Promise<readonly ClaimedIdentityEmail[]> {
  return database.transaction().execute(async (transaction) => {
    const databaseNow = await getDatabaseNow(transaction);
    const candidates = await transaction
      .selectFrom('identity_email_outbox')
      .innerJoin(
        'email_verification_tokens',
        'email_verification_tokens.id',
        'identity_email_outbox.verification_token_id',
      )
      .select([
        'identity_email_outbox.aad',
        'identity_email_outbox.attempt_count',
        'identity_email_outbox.ciphertext',
        'identity_email_outbox.created_at',
        'identity_email_outbox.encrypted_dek',
        'identity_email_outbox.id',
        'identity_email_outbox.iv',
        'identity_email_outbox.key_version',
        'identity_email_outbox.max_attempts',
        'identity_email_outbox.recipient_email',
        'identity_email_outbox.tag',
        'identity_email_outbox.verification_token_id',
        'identity_email_outbox.wrap_iv',
        'identity_email_outbox.wrap_tag',
        sql<boolean>`email_verification_tokens.consumed_at is null
          and email_verification_tokens.superseded_at is null
          and email_verification_tokens.expires_at > now()`.as('verification_token_active'),
      ])
      .where((expression) =>
        expression.or([
          expression.and([
            expression('identity_email_outbox.status', 'in', ['PENDING', 'RETRY_WAIT']),
            expression('identity_email_outbox.available_at', '<=', databaseNow),
          ]),
          expression.and([
            expression('identity_email_outbox.status', '=', 'CLAIMED'),
            expression('identity_email_outbox.claimed_until', '<', databaseNow),
          ]),
        ]),
      )
      .orderBy('identity_email_outbox.created_at', 'asc')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    if (candidates.length === 0) return [];

    const deliveryIds = candidates.map((candidate) => candidate.id);
    await transaction
      .updateTable('identity_email_outbox')
      .set({
        attempt_count: sql<number>`attempt_count + 1`,
        claimed_by: workerId,
        claimed_until: new Date(databaseNow.getTime() + claimSeconds * 1_000),
        status: 'CLAIMED',
      })
      .where('id', 'in', deliveryIds)
      .execute();

    return candidates.map((candidate) => ({
      aad: candidate.aad,
      attemptCount: candidate.attempt_count + 1,
      ciphertext: candidate.ciphertext,
      encryptedDek: candidate.encrypted_dek,
      id: candidate.id,
      iv: candidate.iv,
      keyVersion: candidate.key_version,
      maxAttempts: candidate.max_attempts,
      recipientEmail: candidate.recipient_email,
      tag: candidate.tag,
      verificationTokenId: candidate.verification_token_id,
      verificationTokenActive: candidate.verification_token_active,
      wrapIv: candidate.wrap_iv,
      wrapTag: candidate.wrap_tag,
    }));
  });
}

export async function completeIdentityEmailDelivery(
  database: DeliveryDatabase,
  deliveryId: string,
  workerId: string,
  providerMessageId: string,
): Promise<boolean> {
  const result = await database
    .updateTable('identity_email_outbox')
    .set({
      claimed_by: null,
      claimed_until: null,
      provider_message_id: providerMessageId,
      sent_at: new Date(),
      status: 'SENT',
    })
    .where('id', '=', deliveryId)
    .where('claimed_by', '=', workerId)
    .where('status', '=', 'CLAIMED')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function failIdentityEmailDelivery(
  database: DeliveryDatabase,
  input: Readonly<{
    attemptCount: number;
    deliveryId: string;
    errorCode: string;
    maxAttempts: number;
    retryable: boolean;
    retryDelayMilliseconds: number;
    workerId: string;
  }>,
): Promise<'FAILED' | 'RETRY_WAIT' | 'FENCED'> {
  const exhausted = input.attemptCount >= input.maxAttempts;
  const status = input.retryable && !exhausted ? 'RETRY_WAIT' : 'FAILED';
  const databaseNow = await getDatabaseNow(database);
  const result = await database
    .updateTable('identity_email_outbox')
    .set({
      available_at: new Date(databaseNow.getTime() + input.retryDelayMilliseconds),
      claimed_by: null,
      claimed_until: null,
      last_error_code: input.errorCode,
      status,
    })
    .where('id', '=', input.deliveryId)
    .where('claimed_by', '=', input.workerId)
    .where('status', '=', 'CLAIMED')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n ? status : 'FENCED';
}
