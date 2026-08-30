import { randomUUID } from 'node:crypto';

import { type DeliveryTransaction } from '@delivery/database';
import { encryptSecret } from '@delivery/security';

type IdentityEmailTarget =
  | Readonly<{
      administratorInvitationId: string;
      messageType: 'ADMINISTRATOR_INVITATION';
    }>
  | Readonly<{
      messageType: 'VERIFY_EMAIL';
      verificationTokenId: string;
    }>;

export async function enqueueIdentityEmail(
  transaction: DeliveryTransaction,
  input: Readonly<{
    encryptionKey: Readonly<{ key: Buffer; version: number }>;
    plaintextToken: string;
    recipientEmail: string;
    target: IdentityEmailTarget;
  }>,
): Promise<string> {
  const deliveryId = randomUUID();
  const encrypted = encryptSecret({
    aad: `identity-email:${deliveryId}`,
    keyEncryptionKey: input.encryptionKey.key,
    keyVersion: input.encryptionKey.version,
    plaintext: input.plaintextToken,
  });
  await transaction
    .insertInto('identity_email_outbox')
    .values({
      aad: encrypted.aad,
      administrator_invitation_id:
        input.target.messageType === 'ADMINISTRATOR_INVITATION'
          ? input.target.administratorInvitationId
          : null,
      ciphertext: encrypted.ciphertext,
      claimed_by: null,
      claimed_until: null,
      encrypted_dek: encrypted.encryptedDek,
      id: deliveryId,
      iv: encrypted.iv,
      key_version: encrypted.keyVersion,
      last_error_code: null,
      message_type: input.target.messageType,
      provider_message_id: null,
      recipient_email: input.recipientEmail,
      sent_at: null,
      tag: encrypted.tag,
      verification_token_id:
        input.target.messageType === 'VERIFY_EMAIL' ? input.target.verificationTokenId : null,
      wrap_iv: encrypted.wrapIv,
      wrap_tag: encrypted.wrapTag,
    })
    .executeTakeFirstOrThrow();
  return deliveryId;
}

export async function failPendingAdministratorInvitationEmails(
  transaction: DeliveryTransaction,
  invitationId: string,
  errorCode: string,
): Promise<void> {
  await transaction
    .updateTable('identity_email_outbox')
    .set({ last_error_code: errorCode, status: 'FAILED' })
    .where('administrator_invitation_id', '=', invitationId)
    .where('status', 'in', ['PENDING', 'RETRY_WAIT'])
    .execute();
}
