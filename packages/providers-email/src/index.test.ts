import { describe, expect, it, vi } from 'vitest';

import { EmailProviderError, HttpEmailProvider } from './index.js';

const message = {
  deliveryId: 'delivery-1',
  recipientEmail: 'user@example.com',
  verificationUrl: 'https://web.example.test/verify-email?token=secret',
};

describe('HttpEmailProvider', () => {
  it('uses a stable idempotency key and maps the provider response', async () => {
    let receivedInput: RequestInfo | URL | undefined;
    let receivedInit: RequestInit | undefined;
    const request: typeof fetch = (input, init) => {
      receivedInput = input;
      receivedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'provider-message-1' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    };
    const provider = new HttpEmailProvider('https://email.example.test/send', 'api-key', request);

    await expect(provider.sendVerificationEmail(message)).resolves.toEqual({
      providerMessageId: 'provider-message-1',
    });
    expect(receivedInput).toBe('https://email.example.test/send');
    expect(receivedInit?.method).toBe('POST');
    expect(new Headers(receivedInit?.headers).get('idempotency-key')).toBe('delivery-1');
  });

  it('classifies throttling, server failures, invalid responses, and network errors', async () => {
    const throttled = new HttpEmailProvider(
      'https://email.example.test/send',
      'api-key',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('', { headers: { 'retry-after': '2' }, status: 429 })),
    );
    await expect(throttled.sendVerificationEmail(message)).rejects.toMatchObject({
      code: 'EMAIL_PROVIDER_HTTP_429',
      retryAfterMilliseconds: 2_000,
      retryable: true,
    } satisfies Partial<EmailProviderError>);

    const rejected = new HttpEmailProvider(
      'https://email.example.test/send',
      'api-key',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 400 })),
    );
    await expect(rejected.sendVerificationEmail(message)).rejects.toMatchObject({
      code: 'EMAIL_PROVIDER_HTTP_400',
      retryable: false,
    });

    const invalid = new HttpEmailProvider(
      'https://email.example.test/send',
      'api-key',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json', { status: 200 })),
    );
    await expect(invalid.sendVerificationEmail(message)).rejects.toMatchObject({
      code: 'EMAIL_PROVIDER_RESPONSE_INVALID',
      retryable: false,
    });

    const unavailable = new HttpEmailProvider(
      'https://email.example.test/send',
      'api-key',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('network secret')),
    );
    await expect(unavailable.sendVerificationEmail(message)).rejects.toMatchObject({
      code: 'EMAIL_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});
