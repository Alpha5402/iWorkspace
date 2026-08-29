import {
  claimIdentityEmailDeliveries,
  completeIdentityEmailDelivery,
  failIdentityEmailDelivery,
  type ClaimedIdentityEmail,
  type DeliveryDatabase,
} from '@delivery/database';
import { type EmailProvider, EmailProviderError } from '@delivery/providers-email';
import { decryptSecret } from '@delivery/security';

type EmailWorkerLogger = Readonly<{
  error(attributes: Record<string, unknown>, message: string): void;
  info(attributes: Record<string, unknown>, message: string): void;
}>;

export class EmailDeliveryWorker {
  private activeRun: Promise<void> | undefined;
  private relayTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly provider: EmailProvider,
    private readonly keyEncryptionKeys: ReadonlyMap<number, Buffer>,
    private readonly verificationBaseUrl: string,
    private readonly workerId: string,
    private readonly logger: EmailWorkerLogger,
    private readonly random: () => number = Math.random,
  ) {}

  public async start(): Promise<void> {
    this.relayTimer = setInterval(() => {
      void this.triggerRun().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : 'unknown' },
          'identity email outbox relay failed',
        );
      });
    }, 1_000);
    this.relayTimer.unref();
    await this.triggerRun();
  }

  public async close(): Promise<void> {
    if (this.relayTimer !== undefined) clearInterval(this.relayTimer);
    await this.activeRun;
  }

  public async runOnce(): Promise<void> {
    const deliveries = await claimIdentityEmailDeliveries(this.database, this.workerId, 20, 30);
    await Promise.all(deliveries.map((delivery) => this.deliver(delivery)));
  }

  private async triggerRun(): Promise<void> {
    if (this.activeRun !== undefined) return this.activeRun;
    const run = this.runOnce();
    this.activeRun = run;
    try {
      await run;
    } finally {
      this.activeRun = undefined;
    }
  }

  private async deliver(delivery: ClaimedIdentityEmail): Promise<void> {
    try {
      if (!delivery.verificationTokenActive) {
        throw new EmailProviderError('VERIFICATION_TOKEN_INACTIVE', false);
      }
      const keyEncryptionKey = this.keyEncryptionKeys.get(delivery.keyVersion);
      if (keyEncryptionKey === undefined) {
        throw new EmailProviderError('EMAIL_OUTBOX_KEY_VERSION_UNKNOWN', false);
      }
      const token = decryptSecret(
        {
          aad: delivery.aad,
          ciphertext: delivery.ciphertext,
          encryptedDek: delivery.encryptedDek,
          iv: delivery.iv,
          keyVersion: delivery.keyVersion,
          tag: delivery.tag,
          wrapIv: delivery.wrapIv,
          wrapTag: delivery.wrapTag,
        },
        keyEncryptionKey,
      );
      const verificationUrl = new URL('/verify-email', this.verificationBaseUrl);
      verificationUrl.searchParams.set('token', token);
      const result = await this.provider.sendVerificationEmail({
        deliveryId: delivery.id,
        recipientEmail: delivery.recipientEmail,
        verificationUrl: verificationUrl.toString(),
      });
      if (
        !(await completeIdentityEmailDelivery(
          this.database,
          delivery.id,
          this.workerId,
          result.providerMessageId,
        ))
      ) {
        throw new Error('EMAIL_DELIVERY_FENCING_REJECTED');
      }
      this.logger.info({ deliveryId: delivery.id }, 'identity verification email delivered');
    } catch (error) {
      const providerError =
        error instanceof EmailProviderError
          ? error
          : new EmailProviderError('EMAIL_DELIVERY_UNEXPECTED', true);
      const retryDelay =
        providerError.retryAfterMilliseconds ??
        Math.min(60_000, 1_000 * 2 ** Math.max(0, delivery.attemptCount - 1)) +
          Math.floor(this.random() * 250);
      const result = await failIdentityEmailDelivery(this.database, {
        attemptCount: delivery.attemptCount,
        deliveryId: delivery.id,
        errorCode: providerError.code,
        maxAttempts: delivery.maxAttempts,
        retryable: providerError.retryable,
        retryDelayMilliseconds: retryDelay,
        workerId: this.workerId,
      });
      this.logger.error(
        { deliveryId: delivery.id, errorCode: providerError.code, result },
        'identity verification email delivery failed',
      );
    }
  }
}
