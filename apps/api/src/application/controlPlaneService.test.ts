import { generateKeyPairSync, randomUUID } from 'node:crypto';

import {
  AccessTokenService,
  RefreshTokenService,
  type UserSessionPrincipal,
} from '@delivery/security';
import { createMemoryDatabase } from '@delivery/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService, bootstrapFirstAdmin } from './authService.js';
import { ControlPlaneService } from './controlPlaneService.js';
import { PublicAuthRateLimiter } from './publicAuthRateLimiter.js';

const PEPPER = 'control-plane-test-token-pepper';
const REVIEW_MODEL = 'deepseek-test-model';

function tokenServices(): Readonly<{
  access: AccessTokenService;
  refresh: RefreshTokenService;
}> {
  const accessPair = generateKeyPairSync('ed25519');
  const refreshPair = generateKeyPairSync('ed25519');
  const accessKey = {
    keyId: 'access-test-v1',
    privateKeyPem: accessPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: accessPair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
  const refreshKey = {
    keyId: 'refresh-test-v1',
    privateKeyPem: refreshPair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeyPem: refreshPair.publicKey.export({ format: 'pem', type: 'spki' }),
  };
  return {
    access: new AccessTokenService(
      { current: accessKey, verificationKeys: [accessKey] },
      'test',
      'access',
    ),
    refresh: new RefreshTokenService(
      { current: refreshKey, verificationKeys: [refreshKey] },
      'test',
      'refresh',
    ),
  };
}

const rule = {
  appliesTo: { languages: ['typescript'], paths: ['src/**'] },
  category: 'DEFECT' as const,
  defaultSeverity: 'BLOCKING' as const,
  deterministicHandler: 'secret-detector',
  evidenceRequirement: 'Changed line evidence is required.',
  guidance: 'Reject committed credentials.',
  id: 'security/no-secret',
  title: 'Do not commit credentials',
};

describe('ControlPlaneService', () => {
  let actor: UserSessionPrincipal;
  let auth: AuthService;
  let control: ControlPlaneService;
  let database: Awaited<ReturnType<typeof createMemoryDatabase>>;

  beforeEach(async () => {
    database = await createMemoryDatabase();
    const tokens = tokenServices();
    auth = new AuthService(
      database,
      tokens.access,
      tokens.refresh,
      PEPPER,
      new PublicAuthRateLimiter(database, PEPPER),
    );
    await bootstrapFirstAdmin({
      database,
      email: 'owner@example.com',
      organizationName: 'Example',
      password: 'correct horse battery staple',
    });
    const session = await auth.login({
      email: 'owner@example.com',
      ipAddress: '192.0.2.20',
      password: 'correct horse battery staple',
    });
    actor = await auth.verifyAccessToken(session.accessToken);
    control = new ControlPlaneService(database, PEPPER, Buffer.alloc(32, 7), REVIEW_MODEL);
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('creates a project, enforces project RBAC, and writes audit evidence', async () => {
    await expect(control.listProjects(actor)).resolves.toEqual([]);
    const project = await control.createProject(
      actor,
      { name: 'Review', slug: 'review' },
      'trace-project',
    );
    await expect(control.listProjects(actor)).resolves.toEqual([
      { id: project.id, name: 'Review', role: 'MAINTAINER', slug: 'review' },
    ]);

    const invitation = await control.createInvitation(
      actor,
      { email: 'viewer@example.com', role: 'MEMBER' },
      'trace-member',
    );
    await auth.acceptInvitation({ password: 'viewer secure password', token: invitation.token });
    const viewerSession = await auth.login({
      email: 'viewer@example.com',
      ipAddress: '192.0.2.21',
      password: 'viewer secure password',
    });
    const viewer = await auth.verifyAccessToken(viewerSession.accessToken);
    await expect(control.listRulesets(viewer, project.id)).rejects.toMatchObject({
      code: 'PROJECT_ACCESS_DENIED',
      status: 403,
    });
    await control.setProjectMember(
      actor,
      project.id,
      viewer.userId,
      'VIEWER',
      'trace-project-member',
    );
    await expect(control.listProjectMembers(viewer, project.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: viewer.userId, role: 'VIEWER' })]),
    );
    await control.removeProjectMember(
      actor,
      project.id,
      viewer.userId,
      'trace-project-member-remove',
    );
    await expect(
      control.removeOrganizationMember(actor, actor.userId, 'trace-owner-remove'),
    ).rejects.toMatchObject({
      code: 'LAST_OWNER_PROTECTED',
      status: 409,
    });
    await control.removeOrganizationMember(actor, viewer.userId, 'trace-member-remove');
    const audits = await database
      .selectFrom('audit_events')
      .select(['action', 'trace_id'])
      .orderBy('id')
      .execute();
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: 'project.created', trace_id: 'trace-project' },
        { action: 'invitation.created', trace_id: 'trace-member' },
      ]),
    );
    await expect(
      database
        .selectFrom('audit_events')
        .select(['actor_id', 'actor_type', 'metadata'])
        .where('action', '=', 'project.created')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actor_id: actor.sessionId,
      actor_type: 'USER_SESSION',
      metadata: { subjectUserId: actor.userId },
    });
  });

  it('shows a project token once, authenticates its scope, and revokes it', async () => {
    const project = await control.createProject(actor, { name: 'Review', slug: 'review' }, 'trace');
    const issued = await control.createProjectToken(
      actor,
      project.id,
      { name: 'GitHub Action', scopes: ['review:trigger'] },
      'trace-token',
    );

    expect(issued.token).toMatch(/^iwpat-/);
    const listed = await control.listProjectTokens(actor, project.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    const tokenPrincipal = await control.authenticateProjectToken(
      project.id,
      issued.token,
      'review:trigger',
    );
    expect(tokenPrincipal).toMatchObject({
      projectId: project.id,
      tokenId: issued.id,
      type: 'PROJECT_TOKEN',
    });
    await expect(
      control.authenticateProjectToken(project.id, issued.token, 'artifact:read'),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_TOKEN' });
    const ruleset = await control.createRuleset(
      actor,
      project.id,
      { name: 'Token review', rules: [rule] },
      'trace-ruleset',
    );
    await control.publishRuleset(actor, project.id, ruleset.versionId, 'trace-publish');
    const repository = await control.createRepositoryConnection(
      actor,
      project.id,
      {
        installationId: '101',
        owner: 'example',
        permissions: {},
        repositoryId: '202',
        repositoryName: 'repo',
      },
      'trace-repository',
    );
    await control.triggerReview(
      tokenPrincipal,
      project.id,
      {
        source: {
          pullRequestNumber: 5,
          repositoryConnectionId: repository.id,
          type: 'github_pull_request',
        },
      },
      'token-review-request',
      'trace-token-review',
    );
    await expect(
      database
        .selectFrom('audit_events')
        .select(['actor_id', 'actor_type', 'metadata'])
        .where('action', '=', 'review.accepted')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ actor_id: issued.id, actor_type: 'PROJECT_TOKEN', metadata: {} });

    await control.revokeProjectToken(actor, project.id, issued.id, 'trace-revoke');
    await expect(
      control.authenticateProjectToken(project.id, issued.token, 'review:trigger'),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_TOKEN' });
  });

  it('envelope-encrypts secrets and records rotation without storing plaintext', async () => {
    const project = await control.createProject(actor, { name: 'Review', slug: 'review' }, 'trace');
    const created = await control.createProjectSecret(
      actor,
      project.id,
      { name: 'third-party-key', value: 'plaintext-must-not-appear' },
      'trace-secret',
    );
    expect(created.keyVersion).toBe(1);
    expect(JSON.stringify(await control.listProjectSecrets(actor, project.id))).not.toContain(
      'plaintext-must-not-appear',
    );
    const stored = await database
      .selectFrom('encrypted_secrets')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored)).not.toContain('plaintext-must-not-appear');

    await control.rotateProjectSecret(
      actor,
      project.id,
      created.id,
      'replacement-value',
      'trace-rotate',
    );
    const rotated = await database
      .selectFrom('encrypted_secrets')
      .select('key_version')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(rotated.key_version).toBe(2);
    await expect(
      database.selectFrom('secret_rotation_events').select('id').execute(),
    ).resolves.toHaveLength(1);
  });

  it('publishes an immutable ruleset and accepts an idempotent review trigger', async () => {
    const project = await control.createProject(actor, { name: 'Review', slug: 'review' }, 'trace');
    const ruleset = await control.createRuleset(
      actor,
      project.id,
      { name: 'Default', rules: [rule] },
      'trace-rules',
    );
    await control.publishRuleset(actor, project.id, ruleset.versionId, 'trace-publish');
    await expect(
      control.publishRuleset(actor, project.id, ruleset.versionId, 'trace-publish-again'),
    ).rejects.toMatchObject({ code: 'RULESET_NOT_DRAFT', status: 409 });
    const connection = await control.createRepositoryConnection(
      actor,
      project.id,
      {
        installationId: '11',
        owner: 'example',
        permissions: { checks: 'write', contents: 'read', pull_requests: 'read' },
        repositoryId: '22',
        repositoryName: 'repo',
      },
      'trace-github',
    );
    const trigger = {
      source: {
        pullRequestNumber: 42,
        repositoryConnectionId: connection.id,
        type: 'github_pull_request' as const,
      },
    };
    const first = await control.triggerReview(
      actor,
      project.id,
      trigger,
      'same-request',
      'trace-review',
    );
    const duplicate = await control.triggerReview(
      actor,
      project.id,
      trigger,
      'same-request',
      'trace-duplicate',
    );

    expect(duplicate).toEqual(first);
    await expect(
      database
        .selectFrom('review_runs')
        .select('model')
        .where('id', '=', first.runId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ model: REVIEW_MODEL });
    await expect(control.listReviews(actor, project.id)).resolves.toHaveLength(1);
    await expect(control.listRunEvents(actor, first.runId, 0)).resolves.toHaveLength(1);
    await expect(database.selectFrom('tasks').select('id').execute()).resolves.toHaveLength(1);
    await expect(database.selectFrom('outbox_events').select('id').execute()).resolves.toHaveLength(
      1,
    );
  });

  it('atomically deduplicates concurrent review requests with the same idempotency key', async () => {
    const project = await control.createProject(
      actor,
      { name: 'Concurrent', slug: 'concurrent' },
      'trace',
    );
    const ruleset = await control.createRuleset(
      actor,
      project.id,
      { name: 'Default', rules: [rule] },
      'trace',
    );
    await control.publishRuleset(actor, project.id, ruleset.versionId, 'trace');
    const connection = await control.createRepositoryConnection(
      actor,
      project.id,
      {
        installationId: '31',
        owner: 'example',
        permissions: {},
        repositoryId: '41',
        repositoryName: 'repo',
      },
      'trace',
    );
    const trigger = {
      source: {
        pullRequestNumber: 9,
        repositoryConnectionId: connection.id,
        type: 'github_pull_request' as const,
      },
    };

    const [first, second] = await Promise.all([
      control.triggerReview(actor, project.id, trigger, 'concurrent-key', 'trace-first'),
      control.triggerReview(actor, project.id, trigger, 'concurrent-key', 'trace-second'),
    ]);

    expect(second.runId).toBe(first.runId);
    await expect(database.selectFrom('review_runs').select('id').execute()).resolves.toHaveLength(
      1,
    );
    await expect(database.selectFrom('tasks').select('id').execute()).resolves.toHaveLength(1);
    await expect(database.selectFrom('outbox_events').select('id').execute()).resolves.toHaveLength(
      1,
    );
  });

  it('deduplicates webhook deliveries and the logical PR/head/ruleset run', async () => {
    const project = await control.createProject(actor, { name: 'Review', slug: 'review' }, 'trace');
    const ruleset = await control.createRuleset(
      actor,
      project.id,
      { name: 'Default', rules: [rule] },
      'trace',
    );
    await control.publishRuleset(actor, project.id, ruleset.versionId, 'trace');
    await control.createRepositoryConnection(
      actor,
      project.id,
      {
        installationId: '11',
        owner: 'example',
        permissions: {},
        repositoryId: '22',
        repositoryName: 'repo',
      },
      'trace',
    );
    const webhook = {
      action: 'opened',
      baseSha: 'a'.repeat(40),
      deliveryId: randomUUID(),
      eventName: 'pull_request',
      headSha: 'b'.repeat(40),
      installationId: '11',
      payloadHash: 'payload-hash',
      pullRequestNumber: 7,
      repositoryId: '22',
      traceId: 'trace-webhook',
    };
    const first = await control.acceptGitHubWebhook(webhook);
    await expect(control.acceptGitHubWebhook(webhook)).resolves.toEqual({ duplicate: true });
    const sameCommit = await control.acceptGitHubWebhook({ ...webhook, deliveryId: randomUUID() });

    expect(first.runId).toBeDefined();
    expect(sameCommit.runId).toBe(first.runId);
    if (first.runId === undefined) throw new Error('EXPECTED_WEBHOOK_REVIEW_RUN');
    await expect(
      database
        .selectFrom('review_runs')
        .select('model')
        .where('id', '=', first.runId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ model: REVIEW_MODEL });
    await expect(database.selectFrom('review_runs').select('id').execute()).resolves.toHaveLength(
      1,
    );
    await expect(
      database
        .selectFrom('audit_events')
        .select(['actor_id', 'actor_type', 'metadata'])
        .where('action', '=', 'review.accepted')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actor_id: 'github-webhook',
      actor_type: 'SYSTEM',
      metadata: {
        deliveryId: webhook.deliveryId,
      },
    });
  });

  it('switches only to published rulesets and disconnects repository bindings idempotently', async () => {
    const project = await control.createProject(actor, { name: 'Manage', slug: 'manage' }, 'trace');
    const first = await control.createRuleset(
      actor,
      project.id,
      { name: 'First', rules: [rule] },
      'trace',
    );
    const draft = await control.createRuleset(
      actor,
      project.id,
      { name: 'Draft', rules: [rule] },
      'trace',
    );
    await control.publishRuleset(actor, project.id, first.versionId, 'trace');
    await expect(
      control.setDefaultRulesetVersion(actor, project.id, draft.versionId, 'trace'),
    ).rejects.toMatchObject({ code: 'RULESET_NOT_PUBLISHED', status: 409 });
    await control.setDefaultRulesetVersion(actor, project.id, first.versionId, 'trace');
    await expect(
      database
        .selectFrom('projects')
        .select('default_ruleset_version_id')
        .where('id', '=', project.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ default_ruleset_version_id: first.versionId });

    const connection = await control.createRepositoryConnection(
      actor,
      project.id,
      {
        installationId: '81',
        owner: 'example',
        permissions: {},
        repositoryId: '91',
        repositoryName: 'repo',
      },
      'trace',
    );
    await control.disconnectRepositoryConnection(actor, project.id, connection.id, 'trace');
    await control.disconnectRepositoryConnection(actor, project.id, connection.id, 'trace-again');
    await expect(
      database
        .selectFrom('repository_connections')
        .select('status')
        .where('id', '=', connection.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'REMOVED' });
  });

  it('edits only drafts and creates one serialized draft version per ruleset', async () => {
    const project = await control.createProject(
      actor,
      { name: 'Versioned', slug: 'versioned' },
      'trace',
    );
    const first = await control.createRuleset(
      actor,
      project.id,
      { name: 'Baseline', rules: [rule] },
      'trace-create',
    );
    const revisedRule = { ...rule, title: 'Never commit credentials' };
    const updated = await control.updateRulesetDraft(
      actor,
      project.id,
      first.versionId,
      { rules: [revisedRule] },
      'trace-update',
    );
    expect(updated.contentHash).toHaveLength(64);

    await control.publishRuleset(actor, project.id, first.versionId, 'trace-publish');
    await expect(
      control.updateRulesetDraft(
        actor,
        project.id,
        first.versionId,
        { rules: [rule] },
        'trace-illegal-update',
      ),
    ).rejects.toMatchObject({ code: 'RULESET_NOT_DRAFT', status: 409 });

    const second = await control.createRulesetVersion(
      actor,
      project.id,
      first.rulesetId,
      { rules: [{ ...revisedRule, guidance: 'Reject credentials and private keys.' }] },
      'trace-next-version',
    );
    expect(second.version).toBe(2);
    await expect(
      control.createRulesetVersion(
        actor,
        project.id,
        first.rulesetId,
        { rules: [rule] },
        'trace-duplicate-draft',
      ),
    ).rejects.toMatchObject({ code: 'RULESET_DRAFT_EXISTS', status: 409 });

    const versions = await control.listRulesets(actor, project.id);
    expect(versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'PUBLISHED', version: 1, versionId: first.versionId }),
        expect.objectContaining({ status: 'DRAFT', version: 2, versionId: second.versionId }),
      ]),
    );
    await expect(
      database
        .selectFrom('audit_events')
        .select('action')
        .where('target_id', 'in', [first.versionId, second.versionId])
        .orderBy('occurred_at')
        .execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        { action: 'ruleset.draft_updated' },
        { action: 'ruleset.published' },
        { action: 'ruleset.version_created' },
      ]),
    );
  });
});
