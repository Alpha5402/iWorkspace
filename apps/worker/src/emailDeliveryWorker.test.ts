import { randomUUID } from 'node:crypto';

import { claimIdentityEmailDeliveries, completeIdentityEmailDelivery } from '@delivery/database';
import { type EmailProvider, EmailProviderError } from '@delivery/providers-email';
import { encryptSecret, issueOpaqueToken } from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailDeliveryWorker } from './emailDeliveryWorker.js';

const PEPPER = 'email-worker-test-pepper';
const EMAIL_KEY = Buffer.alloc(32, 4);

class FakeEmailProvider implements EmailProvider {
  public readonly messages: Array<Parameters<EmailProvider['sendVerificationEmail']>[0]> = [];
  public failure: EmailProviderError | undefined;

  public sendVerificationEmail(
    message: Parameters<EmailProvider['sendVerificationEmail']>[0],
  ): Promise<{ providerMessageId: string }> {
    this.messages.push(message);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({ providerMessageId: `provider:${message.deliveryId}` });
  }
}

describe('EmailDeliveryWorker', () => {
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;
  let provider: FakeEmailProvider;

  beforeEach(async () => {
    database = await createMemoryDatabase();
    provider = new FakeEmailProvider();
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('decrypts the token only in memory and completes the outbox delivery', async () => {
    const seeded = await seedDelivery(database);
    const worker = createWorker(database, provider, new Map([[1, EMAIL_KEY]]));

    await worker.runOnce();

    expect(provider.messages).toHaveLength(1);
    const sentMessage = provider.messages.at(0);
    if (sentMessage === undefined) throw new Error('EXPECTED_EMAIL_MESSAGE');
    expect(sentMessage).toMatchObject({
      deliveryId: seeded.deliveryId,
      recipientEmail: 'user@example.com',
    });
    expect(new URL(sentMessage.verificationUrl).searchParams.get('token')).toBe(seeded.token);
    await expect(
      database
        .selectFrom('identity_email_outbox')
        .select(['attempt_count', 'provider_message_id', 'status'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      attempt_count: 1,
      provider_message_id: `provider:${seeded.deliveryId}`,
      status: 'SENT',
    });
  });

  it('retries transient provider failures with the same idempotency key', async () => {
    const seeded = await seedDelivery(database);
    provider.failure = new EmailProviderError('EMAIL_PROVIDER_HTTP_503', true, 1);
    const worker = createWorker(database, provider, new Map([[1, EMAIL_KEY]]));

    await worker.runOnce();
    await expect(
      database
        .selectFrom('identity_email_outbox')
        .select(['attempt_count', 'last_error_code', 'status'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      attempt_count: 1,
      last_error_code: 'EMAIL_PROVIDER_HTTP_503',
      status: 'RETRY_WAIT',
    });

    provider.failure = undefined;
    await database
      .updateTable('identity_email_outbox')
      .set({ available_at: new Date(0) })
      .executeTakeFirstOrThrow();
    await worker.runOnce();
    expect(provider.messages.map((message) => message.deliveryId)).toEqual([
      seeded.deliveryId,
      seeded.deliveryId,
    ]);
    await expect(
      database
        .selectFrom('identity_email_outbox')
        .select(['attempt_count', 'status'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ attempt_count: 2, status: 'SENT' });
  });

  it('delivers a claimed batch concurrently so later leases do not expire in line', async () => {
    await seedDelivery(database);
    await seedDelivery(database);
    const started: string[] = [];
    const completions: Array<() => void> = [];
    const blockingProvider: EmailProvider = {
      sendVerificationEmail(message) {
        started.push(message.deliveryId);
        return new Promise((resolve) => {
          completions.push(() => {
            resolve({ providerMessageId: `provider:${message.deliveryId}` });
          });
        });
      },
    };
    const run = createWorker(database, blockingProvider, new Map([[1, EMAIL_KEY]])).runOnce();

    await vi.waitFor(() => {
      expect(started).toHaveLength(2);
    });
    for (const complete of completions) complete();
    await run;

    await expect(
      database.selectFrom('identity_email_outbox').select('status').execute(),
    ).resolves.toEqual([{ status: 'SENT' }, { status: 'SENT' }]);
  });

  it('fails inactive tokens and unknown KEK versions without calling the provider', async () => {
    await seedDelivery(database);
    await database
      .updateTable('email_verification_tokens')
      .set({ superseded_at: new Date() })
      .executeTakeFirstOrThrow();
    await createWorker(database, provider, new Map([[1, EMAIL_KEY]])).runOnce();
    expect(provider.messages).toEqual([]);
    await expect(
      database
        .selectFrom('identity_email_outbox')
        .select(['last_error_code', 'status'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ last_error_code: 'VERIFICATION_TOKEN_INACTIVE', status: 'FAILED' });

    await database.deleteFrom('identity_email_outbox').execute();
    await database.deleteFrom('email_verification_tokens').execute();
    await seedDelivery(database, 2);
    await createWorker(database, provider, new Map([[1, EMAIL_KEY]])).runOnce();
    expect(provider.messages).toEqual([]);
    await expect(
      database
        .selectFrom('identity_email_outbox')
        .select(['last_error_code', 'status'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      last_error_code: 'EMAIL_OUTBOX_KEY_VERSION_UNKNOWN',
      status: 'FAILED',
    });
  });

  it('allows an expired claim to be recovered and fences the stale worker', async () => {
    const seeded = await seedDelivery(database);
    await expect(claimIdentityEmailDeliveries(database, 'worker-a', 1, 30)).resolves.toHaveLength(
      1,
    );
    await database
      .updateTable('identity_email_outbox')
      .set({ claimed_until: new Date(0) })
      .where('id', '=', seeded.deliveryId)
      .executeTakeFirstOrThrow();
    await expect(claimIdentityEmailDeliveries(database, 'worker-b', 1, 30)).resolves.toHaveLength(
      1,
    );

    await expect(
      completeIdentityEmailDelivery(database, seeded.deliveryId, 'worker-a', 'stale-result'),
    ).resolves.toBe(false);
    await expect(
      completeIdentityEmailDelivery(database, seeded.deliveryId, 'worker-b', 'winner'),
    ).resolves.toBe(true);
  });
});

function createWorker(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  provider: EmailProvider,
  keys: ReadonlyMap<number, Buffer>,
): EmailDeliveryWorker {
  return new EmailDeliveryWorker(
    database,
    provider,
    keys,
    'https://web.example.test',
    'email-worker-test',
    { error: vi.fn(), info: vi.fn() },
    () => 0,
  );
}

async function seedDelivery(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  keyVersion = 1,
): Promise<Readonly<{ deliveryId: string; token: string }>> {
  const user = await database
    .insertInto('users')
    .values({ email: `${randomUUID()}@example.com`, status: 'PENDING_VERIFICATION' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const verificationId = randomUUID();
  const deliveryId = randomUUID();
  const token = issueOpaqueToken('iwverify', PEPPER);
  await database
    .insertInto('email_verification_tokens')
    .values({
      consumed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      id: verificationId,
      superseded_at: null,
      token_hash: token.hash,
      user_id: user.id,
    })
    .executeTakeFirstOrThrow();
  const encrypted = encryptSecret({
    aad: `identity-email:${deliveryId}`,
    keyEncryptionKey: EMAIL_KEY,
    keyVersion,
    plaintext: token.token,
  });
  await database
    .insertInto('identity_email_outbox')
    .values({
      aad: encrypted.aad,
      ciphertext: encrypted.ciphertext,
      claimed_by: null,
      claimed_until: null,
      encrypted_dek: encrypted.encryptedDek,
      id: deliveryId,
      iv: encrypted.iv,
      key_version: encrypted.keyVersion,
      last_error_code: null,
      message_type: 'VERIFY_EMAIL',
      provider_message_id: null,
      recipient_email: 'user@example.com',
      sent_at: null,
      tag: encrypted.tag,
      verification_token_id: verificationId,
      wrap_iv: encrypted.wrapIv,
      wrap_tag: encrypted.wrapTag,
    })
    .executeTakeFirstOrThrow();
  return { deliveryId, token: token.token };
}
