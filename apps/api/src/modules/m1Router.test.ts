import { createHash, createHmac, randomUUID } from 'node:crypto';

import { ErrorResponseSchema } from '@delivery/contracts';
import { createLogger } from '@delivery/observability';
import { type UserSessionPrincipal } from '@delivery/security';
import { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApp } from '../app.js';
import { type M1Runtime } from './m1Router.js';

const WEB_ORIGIN = 'https://web.example.test';
const WEBHOOK_SECRET = 'webhook-secret-with-enough-entropy';
const organizationId = randomUUID();
const projectId = randomUUID();
const userId = randomUUID();
const memberId = randomUUID();
const runId = randomUUID();
const artifactId = randomUUID();
const tokenId = randomUUID();
const secretId = randomUUID();
const versionId = randomUUID();
const rulesetId = randomUUID();
const taskId = randomUUID();

const actor: UserSessionPrincipal = {
  organizationId,
  sessionId: randomUUID(),
  type: 'USER_SESSION',
  userId,
};

const session = {
  accessToken: 'access-token',
  csrfToken: 'csrf-token',
  refreshToken: 'refresh-token',
  user: { id: userId, organizationId, organizationRole: 'OWNER' as const },
};

const sessionCookie = 'iw_access=access-token; iw_refresh=refresh-token; iw_csrf=csrf-token';

function createRuntime(): M1Runtime {
  const content = Buffer.from('verified artifact');
  return {
    admin: {
      getUser: vi.fn().mockResolvedValue({ id: userId }),
      listUsers: vi.fn().mockResolvedValue({ users: [{ id: userId }] }),
      revokeUserSessions: vi.fn().mockResolvedValue({ revokedFamilies: 1 }),
      setPlatformRole: vi.fn().mockResolvedValue({ id: userId, platformRole: 'ADMIN' }),
      setUserStatus: vi.fn().mockResolvedValue({ id: userId, status: 'SUSPENDED' }),
    },
    artifactStore: { get: vi.fn().mockResolvedValue(content) },
    auth: {
      acceptInvitation: vi.fn().mockResolvedValue({ organizationId }),
      changePassword: vi.fn().mockResolvedValue({ revokedFamilies: 1 }),
      listOrganizations: vi.fn().mockResolvedValue([{ current: true, id: organizationId }]),
      listSessions: vi.fn().mockResolvedValue([{ current: true, sessionId: actor.sessionId }]),
      login: vi.fn().mockResolvedValue(session),
      logout: vi.fn().mockResolvedValue(undefined),
      logoutAllSessions: vi.fn().mockResolvedValue({ revokedFamilies: 1 }),
      logoutOtherSessions: vi.fn().mockResolvedValue({ revokedFamilies: 1 }),
      refresh: vi.fn().mockResolvedValue(session),
      revokeSession: vi.fn().mockResolvedValue({ currentSessionRevoked: false }),
      switchOrganization: vi.fn().mockResolvedValue(session),
      verifyAccessToken: vi.fn().mockResolvedValue(actor),
    },
    controlPlane: {
      acceptGitHubWebhook: vi.fn().mockResolvedValue({ accepted: true, duplicate: false }),
      assertProjectManageAccess: vi.fn().mockResolvedValue(undefined),
      authenticateProjectToken: vi
        .fn()
        .mockResolvedValue({ projectId, tokenId, type: 'PROJECT_TOKEN' }),
      createInvitation: vi.fn().mockResolvedValue({ expiresAt: new Date(), token: 'invite-token' }),
      createProject: vi.fn().mockResolvedValue({ id: projectId }),
      createProjectSecret: vi.fn().mockResolvedValue({ id: secretId, name: 'SENTRY_DSN' }),
      createProjectToken: vi.fn().mockResolvedValue({ id: tokenId, token: 'iwpat-secret' }),
      createRepositoryConnection: vi.fn().mockResolvedValue({ id: randomUUID() }),
      createRuleset: vi.fn().mockResolvedValue({ rulesetId, versionId }),
      createRulesetVersion: vi.fn().mockResolvedValue({ version: 2, versionId: randomUUID() }),
      disconnectRepositoryConnection: vi.fn().mockResolvedValue(undefined),
      getArtifactForDownload: vi.fn().mockResolvedValue({
        artifactType: 'summary.txt',
        contentHash: createHash('sha256').update(content).digest('hex'),
        mediaType: 'text/plain',
        objectKey: 'artifact/object',
        sizeBytes: String(content.byteLength),
      }),
      getReview: vi.fn().mockResolvedValue({ id: runId, status: 'RUNNING' }),
      listArtifacts: vi.fn().mockResolvedValue([{ id: artifactId }]),
      listFailedTasks: vi.fn().mockResolvedValue([{ id: taskId }]),
      listFindings: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
      listOrganizationMembers: vi.fn().mockResolvedValue([{ id: userId, role: 'OWNER' }]),
      listProjectMembers: vi.fn().mockResolvedValue([{ id: userId, role: 'MAINTAINER' }]),
      listProjectSecrets: vi.fn().mockResolvedValue([{ id: secretId, name: 'SENTRY_DSN' }]),
      listProjectTokens: vi.fn().mockResolvedValue([{ id: tokenId, name: 'Action' }]),
      listProjects: vi.fn().mockResolvedValue([{ id: projectId, name: 'Review' }]),
      listRepositoryConnections: vi.fn().mockResolvedValue([]),
      listReviews: vi.fn().mockResolvedValue([{ id: runId, status: 'RUNNING' }]),
      listRulesets: vi.fn().mockResolvedValue([{ id: versionId }]),
      listRunEvents: vi.fn().mockResolvedValue([]),
      listUnknownExternalEffects: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
      publishRuleset: vi.fn().mockResolvedValue(undefined),
      removeOrganizationMember: vi.fn().mockResolvedValue(undefined),
      removeProjectMember: vi.fn().mockResolvedValue(undefined),
      replayFailedTask: vi.fn().mockResolvedValue(undefined),
      revokeProjectToken: vi.fn().mockResolvedValue(undefined),
      rotateProjectSecret: vi.fn().mockResolvedValue(undefined),
      setDefaultRulesetVersion: vi.fn().mockResolvedValue(undefined),
      setProjectMember: vi.fn().mockResolvedValue(undefined),
      triggerReview: vi.fn().mockResolvedValue({ id: runId, status: 'ACCEPTED' }),
      updateRulesetDraft: vi.fn().mockResolvedValue({ contentHash: 'hash', versionId }),
    },
    github: {
      createInstallationToken: vi.fn().mockResolvedValue({
        expiresAt: new Date().toISOString(),
        permissions: { checks: 'write', contents: 'read', pull_requests: 'read' },
        token: 'installation-token',
      }),
      getRepository: vi.fn().mockResolvedValue({ id: '20', name: 'repository', owner: 'owner' }),
    },
    githubAppSlug: 'iworkspace-test',
    githubWebhookSecret: WEBHOOK_SECRET,
    registration: {
      register: vi.fn().mockResolvedValue({ accepted: true }),
      resendVerification: vi.fn().mockResolvedValue({ accepted: true }),
      verifyEmail: vi.fn().mockResolvedValue({ organizationId }),
    },
    secureCookies: false,
    webOrigin: WEB_ORIGIN,
  };
}

function createTestApp(runtime: M1Runtime): Express {
  return createApp({
    logger: createLogger('m1-router-test', 'silent'),
    m1Runtime: runtime,
    readinessProbe: { check: vi.fn(), close: vi.fn() },
    serviceName: 'm1-router-test',
  });
}

function responseErrorCode(response: request.Response): string {
  return ErrorResponseSchema.parse(response.body as unknown).error.code;
}

function responseUrl(response: request.Response): string {
  return z.object({ url: z.url() }).parse(response.body as unknown).url;
}

function authenticated(requestBuilder: request.Test): request.Test {
  return requestBuilder.set('Cookie', sessionCookie);
}

function mutating(requestBuilder: request.Test): request.Test {
  return authenticated(requestBuilder).set('Origin', WEB_ORIGIN).set('x-csrf-token', 'csrf-token');
}

describe('M1 HTTP router', () => {
  let runtime: M1Runtime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('sets browser sessions, enforces CSRF, refreshes, logs out, and accepts invitations', async () => {
    const app = createTestApp(runtime);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@example.com', password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('iw_access='),
        expect.stringContaining('iw_refresh='),
      ]),
    );

    const rejected = await authenticated(request(app).post('/api/v1/projects')).send({
      name: 'Review',
      slug: 'review',
    });
    expect(rejected.status).toBe(403);
    expect(responseErrorCode(rejected)).toBe('CSRF_VALIDATION_FAILED');

    await expect(authenticated(request(app).get('/api/v1/me'))).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      request(app)
        .post('/api/v1/invitations/accept')
        .send({ password: 'another secure password', token: 'x'.repeat(24) }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(mutating(request(app).post('/api/v1/auth/refresh'))).resolves.toMatchObject({
      status: 200,
    });
    const logout = await mutating(request(app).post('/api/v1/auth/logout'));
    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('iw_access=;')]),
    );
  });

  it('exposes public registration and email verification without leaking a token', async () => {
    const app = createTestApp(runtime);
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'new@example.com', password: 'correct horse battery staple' });
    const resent = await request(app)
      .post('/api/v1/auth/resend-verification')
      .send({ email: 'new@example.com' });
    const verified = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: `iwverify_${'x'.repeat(32)}` });

    expect(registered.status).toBe(202);
    expect(registered.body).toEqual({ accepted: true });
    expect(JSON.stringify(registered.body)).not.toContain('token');
    expect(resent.status).toBe(202);
    expect(verified).toMatchObject({ status: 200, body: { organizationId } });
    const registrationInput = vi.mocked(runtime.registration.register).mock.calls.at(0)?.at(0);
    expect(registrationInput).toMatchObject({ email: 'new@example.com' });
    expect(registrationInput?.ipAddress).toBeTypeOf('string');
  });

  it('routes organization switching, session controls, and bounded platform administration', async () => {
    const app = createTestApp(runtime);
    await expect(
      authenticated(request(app).get('/api/v1/me/organizations')),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      mutating(request(app).post('/api/v1/auth/switch-organization')).send({ organizationId }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(authenticated(request(app).get('/api/v1/auth/sessions'))).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      mutating(request(app).delete(`/api/v1/auth/sessions/${actor.sessionId}`)),
    ).resolves.toMatchObject({ status: 200 });
    await expect(mutating(request(app).post('/api/v1/auth/logout-others'))).resolves.toMatchObject({
      status: 200,
    });
    const logoutAll = await mutating(request(app).post('/api/v1/auth/logout-all'));
    expect(logoutAll.status).toBe(200);
    expect(logoutAll.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('iw_access=;')]),
    );
    const passwordChange = await mutating(request(app).post('/api/v1/auth/change-password')).send({
      currentPassword: 'correct horse battery staple',
      newPassword: 'a different secure password',
    });
    expect(passwordChange.status).toBe(200);
    expect(passwordChange.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('iw_access=;')]),
    );

    await expect(
      authenticated(
        request(app).get('/api/v1/admin/users').query({ limit: 25, platformRole: 'USER' }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      authenticated(request(app).get(`/api/v1/admin/users/${userId}`)),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      mutating(request(app).patch(`/api/v1/admin/users/${userId}/status`)).send({
        reason: 'Security investigation',
        status: 'SUSPENDED',
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      mutating(request(app).patch(`/api/v1/admin/users/${userId}/platform-role`)).send({
        reason: 'Support delegation',
        role: 'ADMIN',
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      mutating(request(app).post(`/api/v1/admin/users/${userId}/revoke-sessions`)).send({
        reason: 'Security response',
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('validates GitHub webhook signatures and maps pull request identity into one trigger', async () => {
    const app = createTestApp(runtime);
    const payload = {
      action: 'synchronize',
      installation: { id: 10 },
      number: 7,
      pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } },
      repository: { id: 20 },
    };
    const raw = JSON.stringify(payload);
    const invalid = await request(app)
      .post('/api/v1/integrations/github/webhooks')
      .set('x-github-delivery', randomUUID())
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', 'sha256=invalid')
      .send(payload);
    expect(invalid.status).toBe(401);

    const deliveryId = randomUUID();
    const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;
    const accepted = await request(app)
      .post('/api/v1/integrations/github/webhooks')
      .set('Content-Type', 'application/json')
      .set('x-github-delivery', deliveryId)
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', signature)
      .send(raw);
    expect(accepted.status).toBe(202);
    expect(runtime.controlPlane.acceptGitHubWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId, headSha: 'b'.repeat(40), repositoryId: '20' }),
    );
  });

  it('routes organization, project, token, secret, member, and ruleset administration', async () => {
    const app = createTestApp(runtime);
    const rule = {
      appliesTo: { languages: ['typescript'], paths: ['src/**'] },
      category: 'DEFECT',
      defaultSeverity: 'BLOCKING',
      evidenceRequirement: 'Changed line',
      guidance: 'Reject credentials.',
      id: 'security/no-secret',
      title: 'No secrets',
    };
    const calls = [
      authenticated(request(app).get(`/api/v1/organizations/${organizationId}/members`)),
      mutating(request(app).post(`/api/v1/organizations/${organizationId}/invitations`)).send({
        email: 'member@example.com',
      }),
      mutating(request(app).delete(`/api/v1/organizations/${organizationId}/members/${memberId}`)),
      authenticated(request(app).get('/api/v1/projects')),
      mutating(request(app).post('/api/v1/projects')).send({ name: 'Review', slug: 'review' }),
      authenticated(request(app).get(`/api/v1/projects/${projectId}/members`)),
      mutating(request(app).put(`/api/v1/projects/${projectId}/members/${memberId}`)).send({
        role: 'VIEWER',
      }),
      mutating(request(app).delete(`/api/v1/projects/${projectId}/members/${memberId}`)),
      authenticated(request(app).get(`/api/v1/projects/${projectId}/tokens`)),
      mutating(request(app).post(`/api/v1/projects/${projectId}/tokens`)).send({
        name: 'Action',
        scopes: ['review:trigger'],
      }),
      mutating(request(app).delete(`/api/v1/projects/${projectId}/tokens/${tokenId}`)),
      authenticated(request(app).get(`/api/v1/projects/${projectId}/secrets`)),
      mutating(request(app).post(`/api/v1/projects/${projectId}/secrets`)).send({
        name: 'SENTRY_DSN',
        value: 'secret',
      }),
      mutating(request(app).post(`/api/v1/projects/${projectId}/secrets/${secretId}/rotate`)).send({
        value: 'rotated',
      }),
      authenticated(request(app).get(`/api/v1/projects/${projectId}/rulesets`)),
      mutating(request(app).post(`/api/v1/projects/${projectId}/rulesets`)).send({
        name: 'Default',
        rules: [rule],
      }),
      mutating(
        request(app).post(`/api/v1/projects/${projectId}/rulesets/${rulesetId}/versions`),
      ).send({ rules: [rule] }),
      mutating(
        request(app).patch(`/api/v1/projects/${projectId}/ruleset-versions/${versionId}`),
      ).send({ rules: [rule] }),
      mutating(
        request(app).post(`/api/v1/projects/${projectId}/ruleset-versions/${versionId}/publish`),
      ),
      mutating(
        request(app).post(`/api/v1/projects/${projectId}/ruleset-versions/${versionId}/default`),
      ),
    ];
    const responses = await Promise.all(calls);
    expect(responses.map((response) => response.status)).toEqual([
      200, 201, 204, 200, 201, 200, 204, 204, 200, 201, 204, 200, 201, 204, 200, 201, 201, 200, 204,
      204,
    ]);
    expect(runtime.controlPlane.createRulesetVersion).toHaveBeenCalledWith(
      actor,
      projectId,
      rulesetId,
      { rules: [rule] },
      expect.any(String),
    );
    expect(runtime.controlPlane.updateRulesetDraft).toHaveBeenCalledWith(
      actor,
      projectId,
      versionId,
      { rules: [rule] },
      expect.any(String),
    );
  });

  it('protects GitHub installation state and validates installation permissions before binding a repository', async () => {
    const app = createTestApp(runtime);
    const install = await authenticated(
      request(app).get('/api/v1/integrations/github/install-url').query({ projectId }),
    );
    expect(install.status).toBe(200);
    const state = new URL(responseUrl(install)).searchParams.get('state');
    expect(state).not.toBeNull();
    const callback = await authenticated(
      request(app)
        .get('/api/v1/integrations/github/callback')
        .query({ installation_id: '10', state }),
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toContain(`/projects/${projectId}`);

    const bound = await mutating(
      request(app).post(`/api/v1/projects/${projectId}/github-connections`),
    ).send({
      installationId: '10',
      repositoryId: '20',
    });
    expect(bound.status).toBe(201);
    await expect(
      authenticated(request(app).get(`/api/v1/projects/${projectId}/github-connections`)),
    ).resolves.toMatchObject({ status: 200 });
    const disconnected = await mutating(
      request(app).delete(`/api/v1/projects/${projectId}/github-connections/${randomUUID()}`),
    );
    expect(disconnected.status).toBe(204);
    expect(runtime.controlPlane.disconnectRepositoryConnection).toHaveBeenCalledOnce();

    vi.mocked(runtime.github.createInstallationToken).mockResolvedValueOnce({
      expiresAt: new Date().toISOString(),
      permissions: { checks: 'read' },
      token: 'underprivileged',
    });
    const rejected = await mutating(
      request(app).post(`/api/v1/projects/${projectId}/github-connections`),
    ).send({
      installationId: '10',
      repositoryId: '20',
    });
    expect(rejected.status).toBe(409);
    expect(responseErrorCode(rejected)).toBe('GITHUB_PERMISSIONS_INSUFFICIENT');
  });

  it('supports bearer and browser review triggers plus result, admin, and verified artifact reads', async () => {
    const app = createTestApp(runtime);
    const trigger = {
      source: {
        pullRequestNumber: 7,
        repositoryConnectionId: randomUUID(),
        type: 'github_pull_request',
      },
    };
    const bearer = await request(app)
      .post(`/api/v1/projects/${projectId}/reviews`)
      .set('Authorization', 'Bearer iwpat-secret')
      .set('Idempotency-Key', 'action-request-1')
      .send(trigger);
    expect(bearer.status).toBe(202);
    expect(runtime.controlPlane.authenticateProjectToken).toHaveBeenCalled();
    const browser = await mutating(request(app).post(`/api/v1/projects/${projectId}/reviews`))
      .set('Idempotency-Key', 'browser-request-1')
      .send(trigger);
    expect(browser.status).toBe(202);

    const responses = await Promise.all([
      authenticated(request(app).get(`/api/v1/projects/${projectId}/reviews`)),
      authenticated(request(app).get(`/api/v1/projects/${projectId}/admin/failed-tasks`)),
      mutating(
        request(app).post(`/api/v1/projects/${projectId}/admin/failed-tasks/${taskId}/replay`),
      ),
      authenticated(request(app).get(`/api/v1/projects/${projectId}/admin/unknown-effects`)),
      authenticated(request(app).get(`/api/v1/reviews/${runId}`)),
      authenticated(request(app).get(`/api/v1/reviews/${runId}/findings`)),
      authenticated(request(app).get(`/api/v1/reviews/${runId}/artifacts`)),
      authenticated(request(app).get(`/api/v1/artifacts/${artifactId}/download`)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 202, 200, 200, 200, 200, 200,
    ]);
    expect(responses.at(-1)?.text).toBe('verified artifact');
  });

  it('fails closed for invalid sessions, tenant mismatch, webhook headers, state, idempotency, and artifact integrity', async () => {
    const app = createTestApp(runtime);
    await expect(request(app).get('/api/v1/me')).resolves.toMatchObject({ status: 401 });
    vi.mocked(runtime.auth.verifyAccessToken).mockRejectedValueOnce(new Error('expired'));
    const invalidAccess = await authenticated(request(app).get('/api/v1/me'));
    expect(invalidAccess.status).toBe(401);
    expect(responseErrorCode(invalidAccess)).toBe('ACCESS_TOKEN_INVALID');

    const wrongOrganization = await authenticated(
      request(app).get(`/api/v1/organizations/${randomUUID()}/members`),
    );
    expect(wrongOrganization.status).toBe(403);
    expect(responseErrorCode(wrongOrganization)).toBe('ORGANIZATION_ACCESS_DENIED');

    const webhookBody = JSON.stringify({ action: 'created' });
    const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(webhookBody).digest('hex')}`;
    const missingHeaders = await request(app)
      .post('/api/v1/integrations/github/webhooks')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(webhookBody);
    expect(missingHeaders.status).toBe(400);
    const generic = await request(app)
      .post('/api/v1/integrations/github/webhooks')
      .set('Content-Type', 'application/json')
      .set('x-github-delivery', randomUUID())
      .set('x-github-event', 'installation')
      .set('x-hub-signature-256', signature)
      .send(webhookBody);
    expect(generic.status).toBe(202);
    expect(runtime.controlPlane.acceptGitHubWebhook).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'created', eventName: 'installation' }),
    );

    const install = await authenticated(
      request(app).get('/api/v1/integrations/github/install-url').query({ projectId }),
    );
    const state = String(new URL(responseUrl(install)).searchParams.get('state'));
    const invalidState = await authenticated(
      request(app)
        .get('/api/v1/integrations/github/callback')
        .query({ installation_id: '10', state: `${state}x` }),
    );
    expect(invalidState.status).toBe(400);
    expect(responseErrorCode(invalidState)).toBe('GITHUB_STATE_INVALID');

    const missingIdempotency = await mutating(
      request(app).post(`/api/v1/projects/${projectId}/reviews`),
    ).send({
      source: {
        pullRequestNumber: 7,
        repositoryConnectionId: randomUUID(),
        type: 'github_pull_request',
      },
    });
    expect(missingIdempotency.status).toBe(400);

    vi.mocked(runtime.artifactStore.get).mockResolvedValueOnce(Buffer.from('corrupted'));
    const corrupt = await authenticated(
      request(app).get(`/api/v1/artifacts/${artifactId}/download`),
    );
    expect(corrupt.status).toBe(503);
    expect(responseErrorCode(corrupt)).toBe('ARTIFACT_SIZE_MISMATCH');
  });
});
