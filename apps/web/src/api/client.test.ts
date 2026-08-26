import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, createApiClient } from './client.js';

describe('API client', () => {
  it('normalizes capability paths and preserves structured API errors', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            capability: 'review',
            code: 'FEATURE_NOT_IMPLEMENTED',
            message: 'review is planned for M1',
            plannedPhase: 'M1',
            traceId: 'trace-1',
          },
        }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createApiClient(fetchImplementation, '/api/v1');

    await expect(client.getCapability('reviews')).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 501,
    });
    expect(fetchImplementation).toHaveBeenCalledWith('/api/v1/reviews', {
      headers: { accept: 'application/json' },
    });
  });

  it('fails closed when the server violates the error contract', async () => {
    const client = createApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 500 })),
      '/api/v1',
    );

    await expect(client.getCapability('/reviews')).rejects.not.toBeInstanceOf(ApiClientError);
  });
});
