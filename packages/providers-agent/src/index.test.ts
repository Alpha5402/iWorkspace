import { describe, expect, it, vi } from 'vitest';

import { DeepSeekResponsesProvider, ModelProviderError } from './index.js';

const request = {
  category: 'DEFECT' as const,
  diff: '@@ -1 +1 @@\n-old\n+new',
  promptVersion: 'review-v1',
  rules: [
    {
      evidenceRequirement: 'A changed line',
      guidance: 'Find defects',
      id: 'defect/correctness',
      severity: 'MAJOR' as const,
      title: 'Correctness',
    },
  ],
};

describe('DeepSeekResponsesProvider', () => {
  it('validates structured output and preserves usage metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'response-1',
          output: [
            {
              content: [
                {
                  text: JSON.stringify({ findings: [], summary: 'No defect found.' }),
                  type: 'output_text',
                },
              ],
              type: 'message',
            },
          ],
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      ),
    );
    const result = await new DeepSeekResponsesProvider(
      'secret',
      'deepseek-v4-flash',
      'https://test',
      fetchMock,
    ).reviewBatch(request);
    expect(result.output.findings).toEqual([]);
    expect(result.providerResponseId).toBe('response-1');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer secret' }),
    );
  });

  it('classifies rate limits without returning provider bodies', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('sensitive upstream body', { headers: { 'retry-after': '7' }, status: 429 }),
      );
    await expect(
      new DeepSeekResponsesProvider(
        'secret',
        'deepseek-v4-flash',
        'https://test',
        fetchMock,
      ).reviewBatch(request),
    ).rejects.toEqual(expect.objectContaining({ code: 'RATE_LIMITED', retryAfterSeconds: 7 }));
  });

  it('classifies aborts, transport failures, provider failures, and nonnumeric rate-limit delays', async () => {
    const aborted = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(
      new DeepSeekResponsesProvider('secret', 'model', 'https://test', aborted).reviewBatch(
        request,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    const disconnected = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket secret'));
    await expect(
      new DeepSeekResponsesProvider('secret', 'model', 'https://test', disconnected).reviewBatch(
        request,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' });
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    await expect(
      new DeepSeekResponsesProvider('secret', 'model', 'https://test', unavailable).reviewBatch(
        request,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILURE' });
    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { headers: { 'retry-after': 'later' }, status: 429 }));
    const error = await new DeepSeekResponsesProvider('secret', 'model', 'https://test', limited)
      .reviewBatch(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: undefined });
  });

  it.each([
    [{ output: [], status: 'incomplete' }, 'incomplete response'],
    [
      { output: [{ content: [{ type: 'refusal' }], type: 'message' }], status: 'completed' },
      'output text',
    ],
    [
      {
        output: [{ content: [{ text: '{', type: 'output_text' }], type: 'message' }],
        status: 'completed',
      },
      'valid JSON',
    ],
    [
      {
        output: [{ content: [{ text: '{}', type: 'output_text' }], type: 'message' }],
        status: 'completed',
      },
      'review schema',
    ],
  ])('rejects invalid structured response variant %#', async (body, message) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    const failure: unknown = await new DeepSeekResponsesProvider(
      'secret',
      'model',
      'https://test',
      fetchMock,
    )
      .reviewBatch(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelProviderError);
    if (!(failure instanceof ModelProviderError)) throw new Error('EXPECTED_MODEL_PROVIDER_ERROR');
    expect(failure).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(failure.message).toContain(message);
  });

  it('includes repair guidance and forwards cancellation without inventing absent metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                { text: JSON.stringify({ findings: [], summary: 'Fixed.' }), type: 'output_text' },
              ],
              type: 'message',
            },
          ],
          status: 'completed',
        }),
      ),
    );
    const signal = new AbortController().signal;
    const result = await new DeepSeekResponsesProvider(
      'secret',
      'model',
      'https://test',
      fetchMock,
    ).reviewBatch({ ...request, repairInstruction: 'findings must be an array' }, signal);
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('EXPECTED_STRING_REQUEST_BODY');
    const body = JSON.parse(requestBody) as { input: string };
    expect(body.input).toContain('findings must be an array');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(result).not.toHaveProperty('providerResponseId');
    expect(result.usage).toEqual({});
  });
});
