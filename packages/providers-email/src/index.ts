import { z } from 'zod';

export type IdentityEmail = Readonly<{
  actionUrl: string;
  deliveryId: string;
  recipientEmail: string;
  template: 'administrator-invitation' | 'verify-email';
}>;

export type EmailDeliveryResult = Readonly<{ providerMessageId: string }>;

export interface EmailProvider {
  sendIdentityEmail(message: IdentityEmail): Promise<EmailDeliveryResult>;
}

export class EmailProviderError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterMilliseconds?: number,
  ) {
    super(code);
    this.name = 'EmailProviderError';
  }
}

const EmailProviderResponseSchema = z.object({ id: z.string().min(1) });

export class HttpEmailProvider implements EmailProvider {
  public constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  public async sendIdentityEmail(message: IdentityEmail): Promise<EmailDeliveryResult> {
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        body: JSON.stringify({
          template: message.template,
          to: message.recipientEmail,
          variables:
            message.template === 'verify-email'
              ? { verificationUrl: message.actionUrl }
              : { invitationUrl: message.actionUrl },
        }),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.deliveryId,
        },
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new EmailProviderError('EMAIL_PROVIDER_UNAVAILABLE', true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMilliseconds = parseRetryAfter(retryAfter);
      throw new EmailProviderError(
        `EMAIL_PROVIDER_HTTP_${response.status}`,
        retryable,
        retryAfterMilliseconds,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EmailProviderError('EMAIL_PROVIDER_RESPONSE_INVALID', false);
    }
    const parsed = EmailProviderResponseSchema.safeParse(payload);
    if (!parsed.success) throw new EmailProviderError('EMAIL_PROVIDER_RESPONSE_INVALID', false);
    return { providerMessageId: parsed.data.id };
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
