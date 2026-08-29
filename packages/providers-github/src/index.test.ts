import { createHmac, generateKeyPairSync } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { GitHubAppProvider, verifyGitHubWebhookSignature } from './index.js';

describe('GitHub webhook signature', () => {
  it('validates the raw body and rejects modified payloads', () => {
    const rawBody = Buffer.from('{"action":"opened"}');
    const signature = `sha256=${createHmac('sha256', 'secret').update(rawBody).digest('hex')}`;
    expect(verifyGitHubWebhookSignature(rawBody, signature, 'secret')).toBe(true);
    expect(verifyGitHubWebhookSignature(Buffer.from('{}'), 'sha256=00', 'secret')).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, undefined, 'secret')).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, 'md5=invalid', 'secret')).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${'0'.repeat(64)}`, 'secret')).toBe(false);
  });
});

describe('GitHubAppProvider', () => {
  let privateKey: string;

  beforeAll(() => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  });

  it('creates an installation token without exposing the private key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ expires_at: '2026-01-01T00:00:00Z', token: 'installation-token' }),
        ),
      );
    const provider = new GitHubAppProvider('123', privateKey, fetchMock, 'https://github.test');
    await expect(provider.createInstallationToken('456')).resolves.toEqual({
      expiresAt: '2026-01-01T00:00:00Z',
      permissions: {},
      token: 'installation-token',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.test/app/installations/456/access_tokens',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('caps published annotations at fifty', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 42 })));
    const provider = new GitHubAppProvider('123', privateKey, fetchMock, 'https://github.test');
    const annotation = {
      annotation_level: 'warning' as const,
      end_line: 1,
      message: 'message',
      path: 'src/a.ts',
      start_line: 1,
      title: 'title',
    };
    await provider.createCheckRun({
      annotations: Array.from({ length: 60 }, () => annotation),
      conclusion: 'success',
      detailsUrl: 'https://app.test/reviews/run',
      externalId: 'run',
      headSha: 'a'.repeat(40),
      installationToken: 'installation-token',
      name: 'iWorkspace Review',
      owner: 'owner',
      repository: 'repo',
      summary: 'summary',
      title: 'title',
    });
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('EXPECTED_STRING_REQUEST_BODY');
    const body = JSON.parse(requestBody) as {
      output: { annotations: unknown[] };
    };
    expect(body.output.annotations).toHaveLength(50);
  });

  it('reads repository and frozen pull request data with encoded repository paths', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 20, name: 'repo', owner: { login: 'owner' } })),
      new Response(
        JSON.stringify({ base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } }),
      ),
      new Response('diff body'),
      new Response(
        JSON.stringify({ base: { sha: 'a'.repeat(40) }, head: { sha: 'c'.repeat(40) } }),
      ),
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(responses.shift() ?? new Response('', { status: 500 })),
      );
    const provider = new GitHubAppProvider('123', privateKey, fetchMock, 'https://github.test');
    await expect(provider.getRepository('20', 'token')).resolves.toEqual({
      id: '20',
      name: 'repo',
      owner: 'owner',
    });
    await expect(
      provider.getPullRequestSnapshot({
        installationToken: 'token',
        owner: 'space owner',
        pullRequestNumber: 7,
        repository: 'repo/name',
      }),
    ).resolves.toEqual({
      baseSha: 'a'.repeat(40),
      diff: 'diff body',
      headSha: 'b'.repeat(40),
    });
    await expect(
      provider.getPullRequestHead({
        installationToken: 'token',
        owner: 'space owner',
        pullRequestNumber: 7,
        repository: 'repo/name',
      }),
    ).resolves.toBe('c'.repeat(40));
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/repos/space%20owner/repo%2Fname/pulls/7');
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('accept')).toBe(
      'application/vnd.github.v3.diff',
    );
  });

  it('finds checks by external id and returns undefined when reconciliation has no match', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ check_runs: [{ external_id: 'run-1', id: 42 }] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [] })));
    const provider = new GitHubAppProvider('123', privateKey, fetchMock, 'https://github.test');
    const input = {
      externalId: 'run-1',
      headSha: 'a'.repeat(40),
      installationToken: 'token',
      owner: 'owner',
      repository: 'repo',
    };
    await expect(provider.findCheckRunByExternalId(input)).resolves.toBe('42');
    await expect(provider.findCheckRunByExternalId(input)).resolves.toBeUndefined();
  });

  it.each([
    [401, {}, 'AUTHENTICATION'],
    [403, { 'x-ratelimit-remaining': '0' }, 'RATE_LIMITED'],
    [403, {}, 'AUTHENTICATION'],
    [404, {}, 'NOT_FOUND'],
    [503, {}, 'PROVIDER_FAILURE'],
  ])('classifies GitHub HTTP %i as %s', async (status, headers, code) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { headers, status }));
    await expect(
      new GitHubAppProvider('123', privateKey, fetchMock, 'https://github.test').getRepository(
        '20',
        'token',
      ),
    ).rejects.toMatchObject({ code, status });
  });

  it('normalizes network failures without leaking transport details', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket contained secret'));
    await expect(
      new GitHubAppProvider('123', privateKey, fetchMock, 'https://github.test').getRepository(
        '20',
        'token',
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FAILURE',
      message: 'GitHub request failed before a response.',
    });
  });
});
