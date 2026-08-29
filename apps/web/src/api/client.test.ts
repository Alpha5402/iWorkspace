// @vitest-environment jsdom

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
    expect(fetchImplementation).toHaveBeenCalledWith(
      '/api/v1/reviews',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers).get('accept')).toBe(
      'application/json',
    );
  });

  it('fails closed when the server violates the error contract', async () => {
    const client = createApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 500 })),
      '/api/v1',
    );

    await expect(client.getCapability('/reviews')).rejects.not.toBeInstanceOf(ApiClientError);
  });

  it('maps every M1 endpoint and sends CSRF only for mutating browser requests', async () => {
    document.cookie = 'iw_csrf=csrf-value';
    const bodies: unknown[] = [
      {},
      { project: { id: 'project', name: 'Review', role: 'MAINTAINER', slug: 'review' } },
      {},
      undefined,
      { ruleset: { rulesetId: 'ruleset', versionId: 'version' } },
      { token: { id: 'token' } },
      { review: { id: 'run' } },
      { url: 'https://github.test/install' },
      { artifacts: [{ id: 'artifact' }] },
      { findings: [{ id: 'finding' }] },
      { projects: [{ id: 'project', name: 'Review', role: 'MAINTAINER', slug: 'review' }] },
      { connections: [{ id: 'connection' }] },
      { reviews: [{ id: 'run' }] },
      { rulesets: [{ id: 'ruleset' }] },
      { tokens: [{ id: 'token' }] },
      {},
      undefined,
      undefined,
      undefined,
      { review: { runId: 'run', status: 'ACCEPTED' } },
    ];
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(() => {
      const body = bodies.shift();
      return Promise.resolve(
        body === undefined
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
    });
    const client = createApiClient(fetchImplementation, '/api/v1');

    await client.acceptInvitation('invite', 'password');
    await expect(client.createProject({ name: 'Review', slug: 'review' })).resolves.toMatchObject({
      id: 'project',
    });
    await client.createRepositoryConnection('project', { installationId: '10' });
    await client.disconnectRepositoryConnection('project', 'connection');
    await expect(client.createRuleset('project', { name: 'Rules' })).resolves.toEqual({
      rulesetId: 'ruleset',
      versionId: 'version',
    });
    await expect(client.createToken('project', { name: 'Action' })).resolves.toEqual({
      id: 'token',
    });
    await expect(client.getReview('run')).resolves.toEqual({ id: 'run' });
    await expect(client.getGitHubInstallUrl('project id')).resolves.toBe(
      'https://github.test/install',
    );
    await expect(client.listArtifacts('run')).resolves.toHaveLength(1);
    await expect(client.listFindings('run')).resolves.toHaveLength(1);
    await expect(client.listProjects()).resolves.toHaveLength(1);
    await expect(client.listRepositoryConnections('project')).resolves.toHaveLength(1);
    await expect(client.listReviews('project')).resolves.toHaveLength(1);
    await expect(client.listRulesets('project')).resolves.toHaveLength(1);
    await expect(client.listTokens('project')).resolves.toHaveLength(1);
    await client.login('owner@example.com', 'password');
    await client.logout();
    await client.publishRuleset('project', 'version');
    await client.setDefaultRulesetVersion('project', 'version');
    await expect(client.triggerReview('project', { source: {} })).resolves.toEqual({
      runId: 'run',
      status: 'ACCEPTED',
    });

    expect(client.artifactDownloadUrl('artifact')).toBe('/api/v1/artifacts/artifact/download');
    expect(client.eventUrl('run')).toBe('/api/v1/reviews/run/events');
    expect(fetchImplementation.mock.calls[7]?.[0]).toBe(
      '/api/v1/integrations/github/install-url?projectId=project%20id',
    );
    expect(
      new Headers(fetchImplementation.mock.calls[10]?.[1]?.headers).get('x-csrf-token'),
    ).toBeNull();
    expect(new Headers(fetchImplementation.mock.calls[1]?.[1]?.headers).get('x-csrf-token')).toBe(
      'csrf-value',
    );
  });

  it('throws if a planned capability unexpectedly succeeds', async () => {
    const client = createApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }))),
      '/api/v1',
    );
    await expect(client.getCapability('/reviews')).rejects.toThrow('unexpectedly succeeded');
  });

  it('maps public identity, session, organization, and platform-administration endpoints', async () => {
    document.cookie = 'iw_csrf=csrf-value';
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = url.includes('/verify-email')
        ? { organizationId: 'organization' }
        : url.endsWith('/me/organizations')
          ? { organizations: [{ id: 'organization' }] }
          : url.endsWith('/auth/sessions')
            ? { sessions: [{ sessionId: 'session' }] }
            : url.includes('/admin/users/user') && !url.includes('revoke-sessions')
              ? { user: { id: 'user' } }
              : url.includes('/admin/users')
                ? { users: [{ id: 'user' }] }
                : url.includes('/auth/logout') || url.includes('/revoke-sessions')
                  ? { revokedFamilies: 1 }
                  : url.includes('/auth/sessions/')
                    ? { currentSessionRevoked: false }
                    : { accepted: true };
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
    });
    const client = createApiClient(fetchImplementation, '/api/v1');

    await client.register('user@example.com', 'another secure password');
    await client.resendVerification('user@example.com');
    await expect(client.verifyEmail('verification-token')).resolves.toEqual({
      organizationId: 'organization',
    });
    await expect(client.listOrganizations()).resolves.toHaveLength(1);
    await client.switchOrganization('organization');
    await expect(client.listSessions()).resolves.toHaveLength(1);
    await client.revokeSession('session');
    await client.logoutOtherSessions();
    await client.logoutAllSessions();
    await expect(
      client.listPlatformUsers({ limit: 25, platformRole: 'USER', status: 'ACTIVE' }),
    ).resolves.toMatchObject({ users: [{ id: 'user' }] });
    await expect(client.getPlatformUser('user')).resolves.toEqual({ id: 'user' });
    await client.setPlatformUserStatus('user', 'SUSPENDED', 'Security response');
    await client.setPlatformUserRole('user', 'ADMIN', 'Support delegation');
    await client.revokePlatformUserSessions('user', 'Security response');

    expect(fetchImplementation.mock.calls.map((call) => call[0])).toContain(
      '/api/v1/admin/users?limit=25&platformRole=USER&status=ACTIVE',
    );
    expect(
      new Headers(fetchImplementation.mock.calls.at(-1)?.[1]?.headers).get('x-csrf-token'),
    ).toBe('csrf-value');
  });
});
