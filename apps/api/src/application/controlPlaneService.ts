import { createHash, randomUUID } from 'node:crypto';

import {
  insertOutboxEvent,
  type DeliveryDatabase,
  type DeliveryTransaction,
  withTenant,
} from '@delivery/database';
import {
  ProjectTokenScopeSchema,
  RuleDefinitionSchema,
  type ProjectTokenScope,
  type ReviewTrigger,
} from '@delivery/contracts';
import {
  decryptSecret,
  encryptSecret,
  hasPermission,
  issueOpaqueToken,
  principalAuditMetadata,
  principalId,
  verifyOpaqueToken,
  type Permission,
  type ProjectRole,
  type ProjectTokenPrincipal,
  type SystemPrincipal,
  type UserSessionPrincipal,
} from '@delivery/security';

import { HttpError } from '../errors.js';

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TASK_EVENT_TYPE: Readonly<Record<string, string>> = {
  ACQUIRE_SOURCE: 'review.acquire.requested',
  ANALYZE_REVIEW: 'review.analyze.requested',
  PUBLISH_CHECK: 'review.publish.requested',
  VERIFY_FINDINGS: 'review.verify.requested',
};

export class ControlPlaneService {
  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly tokenPepper: string,
    private readonly keyEncryptionKey?: Buffer,
  ) {}

  public async listProjects(actor: UserSessionPrincipal): Promise<
    readonly Readonly<{
      id: string;
      name: string;
      role: ProjectRole;
      slug: string;
    }>[]
  > {
    return withTenant(this.database, actor.organizationId, async (transaction) =>
      transaction
        .selectFrom('projects')
        .innerJoin('project_members', (join) =>
          join
            .onRef('project_members.project_id', '=', 'projects.id')
            .on('project_members.user_id', '=', actor.userId),
        )
        .select(['projects.id', 'projects.name', 'projects.slug', 'project_members.role'])
        .where('projects.organization_id', '=', actor.organizationId)
        .orderBy('projects.created_at', 'asc')
        .execute(),
    );
  }

  public async createProject(
    actor: UserSessionPrincipal,
    input: Readonly<{ name: string; slug: string }>,
    traceId: string,
  ): Promise<Readonly<{ id: string; name: string; slug: string }>> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertOrganizationPermission(transaction, actor, 'organization:manage');
      const project = await transaction
        .insertInto('projects')
        .values({
          default_ruleset_version_id: null,
          name: input.name,
          organization_id: actor.organizationId,
          slug: input.slug,
        })
        .returning(['id', 'name', 'slug'])
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('project_members')
        .values({
          organization_id: actor.organizationId,
          project_id: project.id,
          role: 'MAINTAINER',
          user_id: actor.userId,
        })
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'project.created',
        'PROJECT',
        project.id,
        traceId,
        project.id,
      );
      return project;
    });
  }

  public async createInvitation(
    actor: UserSessionPrincipal,
    input: Readonly<{ email: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }>,
    traceId: string,
  ): Promise<Readonly<{ expiresAt: string; token: string }>> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertOrganizationPermission(transaction, actor, 'organization:manage');
      const invitationId = randomUUID();
      const invitation = issueOpaqueToken(`iwinvite-${invitationId}`, this.tokenPepper);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      await transaction
        .insertInto('invitations')
        .values({
          accepted_at: null,
          created_by: actor.userId,
          email_canonical: input.email.trim().toLocaleLowerCase(),
          expires_at: expiresAt,
          id: invitationId,
          organization_id: actor.organizationId,
          organization_role: input.role,
          token_hash: invitation.hash,
        })
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'invitation.created',
        'INVITATION',
        invitationId,
        traceId,
        null,
        { emailCanonical: input.email.trim().toLocaleLowerCase(), role: input.role },
      );
      return { expiresAt: expiresAt.toISOString(), token: invitation.token };
    });
  }

  public async listOrganizationMembers(actor: UserSessionPrincipal): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertOrganizationPermission(transaction, actor, 'organization:manage');
      return transaction
        .selectFrom('organization_members')
        .innerJoin('users', 'users.id', 'organization_members.user_id')
        .select([
          'users.id',
          'users.email',
          'organization_members.role',
          'organization_members.created_at as createdAt',
        ])
        .where('organization_members.organization_id', '=', actor.organizationId)
        .orderBy('organization_members.created_at', 'asc')
        .execute();
    });
  }

  public async removeOrganizationMember(
    actor: UserSessionPrincipal,
    userId: string,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertOrganizationPermission(transaction, actor, 'organization:manage');
      const member = await transaction
        .selectFrom('organization_members')
        .select('role')
        .where('organization_id', '=', actor.organizationId)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (member === undefined)
        throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Organization member was not found.');
      if (member.role === 'OWNER') {
        const owners = await transaction
          .selectFrom('organization_members')
          .select((expression) => expression.fn.countAll<number>().as('count'))
          .where('organization_id', '=', actor.organizationId)
          .where('role', '=', 'OWNER')
          .executeTakeFirstOrThrow();
        if (owners.count <= 1) {
          throw new HttpError(
            409,
            'LAST_OWNER_PROTECTED',
            'The last organization owner cannot be removed.',
          );
        }
      }
      await transaction
        .deleteFrom('organization_members')
        .where('organization_id', '=', actor.organizationId)
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'organization_member.removed',
        'USER',
        userId,
        traceId,
        null,
      );
    });
  }

  public async listProjectMembers(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'review:read');
      return transaction
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .select([
          'users.id',
          'users.email',
          'project_members.role',
          'project_members.created_at as createdAt',
        ])
        .where('project_members.project_id', '=', projectId)
        .orderBy('project_members.created_at', 'asc')
        .execute();
    });
  }

  public async setProjectMember(
    actor: UserSessionPrincipal,
    projectId: string,
    userId: string,
    role: ProjectRole,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const organizationMember = await transaction
        .selectFrom('organization_members')
        .select('user_id')
        .where('organization_id', '=', actor.organizationId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (organizationMember === undefined) {
        throw new HttpError(
          409,
          'ORGANIZATION_MEMBERSHIP_REQUIRED',
          'Project members must belong to the organization.',
        );
      }
      await transaction
        .insertInto('project_members')
        .values({
          organization_id: actor.organizationId,
          project_id: projectId,
          role,
          user_id: userId,
        })
        .onConflict((conflict) => conflict.columns(['project_id', 'user_id']).doUpdateSet({ role }))
        .execute();
      await this.audit(
        transaction,
        actor,
        'project_member.updated',
        'USER',
        userId,
        traceId,
        projectId,
        { role },
      );
    });
  }

  public async removeProjectMember(
    actor: UserSessionPrincipal,
    projectId: string,
    userId: string,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const deleted = await transaction
        .deleteFrom('project_members')
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (deleted.numDeletedRows !== 1n)
        throw new HttpError(404, 'PROJECT_MEMBER_NOT_FOUND', 'Project member was not found.');
      await this.audit(
        transaction,
        actor,
        'project_member.removed',
        'USER',
        userId,
        traceId,
        projectId,
      );
    });
  }

  public async createProjectToken(
    actor: UserSessionPrincipal,
    projectId: string,
    input: Readonly<{
      expiresAt?: string | undefined;
      name: string;
      scopes: readonly ProjectTokenScope[];
    }>,
    traceId: string,
  ): Promise<
    Readonly<{
      expiresAt?: string;
      id: string;
      name: string;
      prefix: string;
      scopes: readonly ProjectTokenScope[];
      token: string;
    }>
  > {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const id = randomUUID();
      const issued = issueOpaqueToken(`iwpat-${id}`, this.tokenPepper);
      const expiresAt = input.expiresAt === undefined ? undefined : new Date(input.expiresAt);
      await transaction
        .insertInto('project_api_tokens')
        .values({
          created_by: actor.userId,
          expires_at: expiresAt ?? null,
          id,
          name: input.name,
          organization_id: actor.organizationId,
          project_id: projectId,
          revoked_at: null,
          scopes: [...input.scopes],
          token_hash: issued.hash,
          token_prefix: issued.prefix,
        })
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'project_token.created',
        'PROJECT_TOKEN',
        id,
        traceId,
        projectId,
        {
          scopes: input.scopes,
        },
      );
      return {
        ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
        id,
        name: input.name,
        prefix: issued.prefix,
        scopes: input.scopes,
        token: issued.token,
      };
    });
  }

  public async listProjectTokens(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      return transaction
        .selectFrom('project_api_tokens')
        .select([
          'id',
          'name',
          'token_prefix as prefix',
          'scopes',
          'expires_at as expiresAt',
          'revoked_at as revokedAt',
          'created_at as createdAt',
        ])
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .execute();
    });
  }

  public async createProjectSecret(
    actor: UserSessionPrincipal,
    projectId: string,
    input: Readonly<{ name: string; value: string }>,
    traceId: string,
  ): Promise<Readonly<{ id: string; keyVersion: number; name: string }>> {
    const keyEncryptionKey = this.requireKeyEncryptionKey();
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const envelope = encryptSecret({
        aad: `organization:${actor.organizationId}:project:${projectId}:secret:${input.name}`,
        keyEncryptionKey,
        keyVersion: 1,
        plaintext: input.value,
      });
      const secret = await transaction
        .insertInto('encrypted_secrets')
        .values({
          aad: envelope.aad,
          ciphertext: envelope.ciphertext,
          encrypted_dek: envelope.encryptedDek,
          iv: envelope.iv,
          key_version: envelope.keyVersion,
          name: input.name,
          organization_id: actor.organizationId,
          project_id: projectId,
          rotated_at: null,
          tag: envelope.tag,
          wrap_iv: envelope.wrapIv,
          wrap_tag: envelope.wrapTag,
        })
        .returning(['id', 'key_version as keyVersion', 'name'])
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'secret.created',
        'ENCRYPTED_SECRET',
        secret.id,
        traceId,
        projectId,
      );
      return secret;
    });
  }

  public async listProjectSecrets(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      return transaction
        .selectFrom('encrypted_secrets')
        .select([
          'id',
          'name',
          'key_version as keyVersion',
          'created_at as createdAt',
          'rotated_at as rotatedAt',
        ])
        .where('project_id', '=', projectId)
        .execute();
    });
  }

  public async rotateProjectSecret(
    actor: UserSessionPrincipal,
    projectId: string,
    secretId: string,
    value: string,
    traceId: string,
  ): Promise<void> {
    const keyEncryptionKey = this.requireKeyEncryptionKey();
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const current = await transaction
        .selectFrom('encrypted_secrets')
        .selectAll()
        .where('id', '=', secretId)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined)
        throw new HttpError(404, 'SECRET_NOT_FOUND', 'Secret was not found.');
      decryptSecret(
        {
          aad: current.aad,
          ciphertext: current.ciphertext,
          encryptedDek: current.encrypted_dek,
          iv: current.iv,
          keyVersion: current.key_version,
          tag: current.tag,
          wrapIv: current.wrap_iv,
          wrapTag: current.wrap_tag,
        },
        keyEncryptionKey,
      );
      const next = encryptSecret({
        aad: current.aad,
        keyEncryptionKey,
        keyVersion: current.key_version + 1,
        plaintext: value,
      });
      await transaction
        .updateTable('encrypted_secrets')
        .set({
          ciphertext: next.ciphertext,
          encrypted_dek: next.encryptedDek,
          iv: next.iv,
          key_version: next.keyVersion,
          rotated_at: new Date(),
          tag: next.tag,
          wrap_iv: next.wrapIv,
          wrap_tag: next.wrapTag,
        })
        .where('id', '=', secretId)
        .where('key_version', '=', current.key_version)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('secret_rotation_events')
        .values({
          from_key_version: current.key_version,
          organization_id: actor.organizationId,
          project_id: projectId,
          rotated_by: actor.userId,
          secret_id: secretId,
          to_key_version: next.keyVersion,
        })
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'secret.rotated',
        'ENCRYPTED_SECRET',
        secretId,
        traceId,
        projectId,
        {
          fromKeyVersion: current.key_version,
          toKeyVersion: next.keyVersion,
        },
      );
    });
  }

  public async revokeProjectToken(
    actor: UserSessionPrincipal,
    projectId: string,
    tokenId: string,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const result = await transaction
        .updateTable('project_api_tokens')
        .set({ revoked_at: new Date() })
        .where('id', '=', tokenId)
        .where('project_id', '=', projectId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n)
        throw new HttpError(404, 'TOKEN_NOT_FOUND', 'Token was not found.');
      await this.audit(
        transaction,
        actor,
        'project_token.revoked',
        'PROJECT_TOKEN',
        tokenId,
        traceId,
        projectId,
      );
    });
  }

  public async authenticateProjectToken(
    projectId: string,
    token: string,
    requiredScope: ProjectTokenScope,
  ): Promise<ProjectTokenPrincipal> {
    const tokenId = /^iwpat-([0-9a-f-]{36})_/.exec(token)?.[1];
    if (tokenId === undefined)
      throw new HttpError(401, 'INVALID_PROJECT_TOKEN', 'Project token is invalid.');
    const record = await this.database
      .selectFrom('project_api_tokens')
      .select([
        'id',
        'organization_id',
        'project_id',
        'token_hash',
        'scopes',
        'expires_at',
        'revoked_at',
      ])
      .where('id', '=', tokenId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (
      record === undefined ||
      record.revoked_at !== null ||
      (record.expires_at !== null && record.expires_at <= new Date()) ||
      !record.scopes.includes(requiredScope) ||
      !verifyOpaqueToken(token, record.token_hash, this.tokenPepper)
    ) {
      throw new HttpError(401, 'INVALID_PROJECT_TOKEN', 'Project token is invalid or lacks scope.');
    }
    return {
      organizationId: record.organization_id,
      projectId: record.project_id,
      scopes: ProjectTokenScopeSchema.array().parse(record.scopes),
      tokenId: record.id,
      type: 'PROJECT_TOKEN',
    };
  }

  public async createRuleset(
    actor: UserSessionPrincipal,
    projectId: string,
    input: Readonly<{ name: string; rules: readonly unknown[] }>,
    traceId: string,
  ): Promise<Readonly<{ rulesetId: string; versionId: string }>> {
    const rules = input.rules.map((rule) => RuleDefinitionSchema.parse(rule));
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const ruleset = await transaction
        .insertInto('rulesets')
        .values({
          created_by: actor.userId,
          name: input.name,
          organization_id: actor.organizationId,
          project_id: projectId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const version = await transaction
        .insertInto('ruleset_versions')
        .values({
          content_hash: sha256(canonicalize(rules)),
          created_by: actor.userId,
          organization_id: actor.organizationId,
          project_id: projectId,
          published_at: null,
          rules: JSON.stringify(rules),
          ruleset_id: ruleset.id,
          status: 'DRAFT',
          version: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'ruleset.created',
        'RULESET',
        ruleset.id,
        traceId,
        projectId,
      );
      return { rulesetId: ruleset.id, versionId: version.id };
    });
  }

  public async publishRuleset(
    actor: UserSessionPrincipal,
    projectId: string,
    versionId: string,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const result = await transaction
        .updateTable('ruleset_versions')
        .set({ published_at: new Date(), status: 'PUBLISHED' })
        .where('id', '=', versionId)
        .where('project_id', '=', projectId)
        .where('status', '=', 'DRAFT')
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw new HttpError(
          409,
          'RULESET_NOT_DRAFT',
          'Only a draft ruleset version can be published.',
        );
      }
      await transaction
        .updateTable('projects')
        .set({ default_ruleset_version_id: versionId })
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'ruleset.published',
        'RULESET_VERSION',
        versionId,
        traceId,
        projectId,
      );
    });
  }

  public async updateRulesetDraft(
    actor: UserSessionPrincipal,
    projectId: string,
    versionId: string,
    input: Readonly<{ rules: readonly unknown[] }>,
    traceId: string,
  ): Promise<Readonly<{ contentHash: string; versionId: string }>> {
    const rules = input.rules.map((rule) => RuleDefinitionSchema.parse(rule));
    const contentHash = sha256(canonicalize(rules));
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const updated = await transaction
        .updateTable('ruleset_versions')
        .set({ content_hash: contentHash, rules: JSON.stringify(rules) })
        .where('id', '=', versionId)
        .where('project_id', '=', projectId)
        .where('status', '=', 'DRAFT')
        .returning('id')
        .executeTakeFirst();
      if (updated === undefined) {
        throw new HttpError(
          409,
          'RULESET_NOT_DRAFT',
          'Only a draft ruleset version can be edited.',
        );
      }
      await this.audit(
        transaction,
        actor,
        'ruleset.draft_updated',
        'RULESET_VERSION',
        versionId,
        traceId,
        projectId,
      );
      return { contentHash, versionId: updated.id };
    });
  }

  public async createRulesetVersion(
    actor: UserSessionPrincipal,
    projectId: string,
    rulesetId: string,
    input: Readonly<{ rules: readonly unknown[] }>,
    traceId: string,
  ): Promise<Readonly<{ version: number; versionId: string }>> {
    const rules = input.rules.map((rule) => RuleDefinitionSchema.parse(rule));
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const ruleset = await transaction
        .selectFrom('rulesets')
        .select('id')
        .where('id', '=', rulesetId)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (ruleset === undefined) {
        throw new HttpError(404, 'RULESET_NOT_FOUND', 'Ruleset was not found.');
      }
      const versions = await transaction
        .selectFrom('ruleset_versions')
        .select(['status', 'version'])
        .where('ruleset_id', '=', rulesetId)
        .orderBy('version', 'desc')
        .execute();
      if (versions.some((version) => version.status === 'DRAFT')) {
        throw new HttpError(
          409,
          'RULESET_DRAFT_EXISTS',
          'Publish or continue editing the existing draft before creating another version.',
        );
      }
      const versionNumber = (versions[0]?.version ?? 0) + 1;
      const version = await transaction
        .insertInto('ruleset_versions')
        .values({
          content_hash: sha256(canonicalize(rules)),
          created_by: actor.userId,
          organization_id: actor.organizationId,
          project_id: projectId,
          published_at: null,
          rules: JSON.stringify(rules),
          ruleset_id: rulesetId,
          status: 'DRAFT',
          version: versionNumber,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'ruleset.version_created',
        'RULESET_VERSION',
        version.id,
        traceId,
        projectId,
      );
      return { version: versionNumber, versionId: version.id };
    });
  }

  public async setDefaultRulesetVersion(
    actor: UserSessionPrincipal,
    projectId: string,
    versionId: string,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const version = await transaction
        .selectFrom('ruleset_versions')
        .select('id')
        .where('id', '=', versionId)
        .where('project_id', '=', projectId)
        .where('status', '=', 'PUBLISHED')
        .executeTakeFirst();
      if (version === undefined) {
        throw new HttpError(
          409,
          'RULESET_NOT_PUBLISHED',
          'Only a published ruleset version can become the project default.',
        );
      }
      await transaction
        .updateTable('projects')
        .set({ default_ruleset_version_id: versionId })
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'ruleset.default_changed',
        'RULESET_VERSION',
        versionId,
        traceId,
        projectId,
      );
    });
  }

  public async listRulesets(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'review:read');
      return transaction
        .selectFrom('rulesets')
        .innerJoin('ruleset_versions', 'ruleset_versions.ruleset_id', 'rulesets.id')
        .select([
          'rulesets.id as rulesetId',
          'rulesets.name',
          'ruleset_versions.id as versionId',
          'ruleset_versions.version',
          'ruleset_versions.status',
          'ruleset_versions.content_hash as contentHash',
          'ruleset_versions.rules',
        ])
        .where('rulesets.project_id', '=', projectId)
        .orderBy('rulesets.created_at', 'desc')
        .orderBy('ruleset_versions.version', 'desc')
        .execute();
    });
  }

  public async createRepositoryConnection(
    actor: UserSessionPrincipal,
    projectId: string,
    input: Readonly<{
      installationId: string;
      owner: string;
      permissions: Record<string, unknown>;
      repositoryId: string;
      repositoryName: string;
    }>,
    traceId: string,
  ): Promise<Readonly<{ id: string }>> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const connection = await transaction
        .insertInto('repository_connections')
        .values({
          installation_id: input.installationId,
          organization_id: actor.organizationId,
          owner_login: input.owner,
          permissions: input.permissions,
          project_id: projectId,
          repository_id: input.repositoryId,
          repository_name: input.repositoryName,
          status: 'ACTIVE',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'github.connected',
        'REPOSITORY_CONNECTION',
        connection.id,
        traceId,
        projectId,
      );
      return connection;
    });
  }

  public async listRepositoryConnections(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      return transaction
        .selectFrom('repository_connections')
        .select([
          'id',
          'installation_id as installationId',
          'repository_id as repositoryId',
          'owner_login as owner',
          'repository_name as repositoryName',
          'permissions',
          'status',
        ])
        .where('project_id', '=', projectId)
        .execute();
    });
  }

  public async disconnectRepositoryConnection(
    actor: UserSessionPrincipal,
    projectId: string,
    connectionId: string,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const connection = await transaction
        .selectFrom('repository_connections')
        .select('status')
        .where('id', '=', connectionId)
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      if (connection === undefined) {
        throw new HttpError(
          404,
          'REPOSITORY_CONNECTION_NOT_FOUND',
          'Repository connection was not found.',
        );
      }
      if (connection.status === 'REMOVED') return;
      await transaction
        .updateTable('repository_connections')
        .set({ status: 'REMOVED' })
        .where('id', '=', connectionId)
        .where('project_id', '=', projectId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirstOrThrow();
      await this.audit(
        transaction,
        actor,
        'github.disconnected',
        'REPOSITORY_CONNECTION',
        connectionId,
        traceId,
        projectId,
      );
    });
  }

  public async assertProjectManageAccess(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, (transaction) =>
      this.assertProjectPermission(transaction, actor, projectId, 'project:manage'),
    );
  }

  public async triggerReview(
    actor: UserSessionPrincipal | ProjectTokenPrincipal,
    projectId: string,
    trigger: ReviewTrigger,
    idempotencyKey: string,
    traceId: string,
  ): Promise<Readonly<{ runId: string; status: 'ACCEPTED' }>> {
    if (actor.type === 'USER_SESSION') {
      return withTenant(this.database, actor.organizationId, async (transaction) => {
        await this.assertProjectPermission(transaction, actor, projectId, 'review:trigger');
        return this.insertAcceptedReview(
          transaction,
          actor,
          projectId,
          trigger,
          idempotencyKey,
          traceId,
        );
      });
    }
    if (actor.projectId !== projectId || !actor.scopes.includes('review:trigger')) {
      throw new HttpError(
        403,
        'PROJECT_ACCESS_DENIED',
        'Project token cannot trigger this project.',
      );
    }
    return withTenant(this.database, actor.organizationId, (transaction) =>
      this.insertAcceptedReview(transaction, actor, projectId, trigger, idempotencyKey, traceId),
    );
  }

  public async listReviews(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'review:read');
      return transaction
        .selectFrom('review_runs')
        .select([
          'id',
          'pull_request_number as pullRequestNumber',
          'head_sha as headSha',
          'status',
          'coverage_complete as coverageComplete',
          'created_at as createdAt',
          'completed_at as completedAt',
        ])
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .execute();
    });
  }

  public async listFailedTasks(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      return transaction
        .selectFrom('tasks')
        .select([
          'id',
          'run_id as runId',
          'task_type as taskType',
          'attempt_count as attemptCount',
          'max_attempts as maxAttempts',
          'created_at as createdAt',
        ])
        .where('project_id', '=', projectId)
        .where('status', '=', 'FAILED')
        .orderBy('created_at', 'desc')
        .execute();
    });
  }

  public async replayFailedTask(
    actor: UserSessionPrincipal,
    projectId: string,
    taskId: string,
    traceId: string,
  ): Promise<void> {
    await withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      const task = await transaction
        .selectFrom('tasks')
        .selectAll()
        .where('id', '=', taskId)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (task === undefined || task.status !== 'FAILED') {
        throw new HttpError(409, 'TASK_NOT_REPLAYABLE', 'Only a failed task can be replayed.');
      }
      const eventType = TASK_EVENT_TYPE[task.task_type];
      if (eventType === undefined)
        throw new HttpError(409, 'TASK_TYPE_NOT_REPLAYABLE', 'Task type cannot be replayed.');
      const previousAttempt = await transaction
        .selectFrom('task_attempts')
        .select('source_event_id')
        .where('task_id', '=', task.id)
        .orderBy('attempt_number', 'desc')
        .executeTakeFirst();
      await transaction
        .updateTable('tasks')
        .set({
          available_at: new Date(),
          max_attempts: task.attempt_count + 3,
          status: 'RETRY_WAIT',
          version: task.version + 1,
        })
        .where('id', '=', task.id)
        .where('version', '=', task.version)
        .executeTakeFirstOrThrow();
      await insertOutboxEvent(transaction, {
        ...(previousAttempt?.source_event_id === null || previousAttempt === undefined
          ? {}
          : { causationId: previousAttempt.source_event_id }),
        correlationId: task.run_id,
        eventId: randomUUID(),
        eventType,
        organizationId: task.organization_id,
        payload: { runId: task.run_id, taskId: task.id },
        projectId: task.project_id,
      });
      await this.audit(transaction, actor, 'task.replayed', 'TASK', task.id, traceId, projectId, {
        previousAttemptCount: task.attempt_count,
      });
    });
  }

  public async listUnknownExternalEffects(
    actor: UserSessionPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      await this.assertProjectPermission(transaction, actor, projectId, 'project:manage');
      return transaction
        .selectFrom('external_effects')
        .select([
          'id',
          'run_id as runId',
          'provider',
          'effect_type as effectType',
          'logical_key as logicalKey',
          'attempt_count as attemptCount',
          'updated_at as updatedAt',
        ])
        .where('project_id', '=', projectId)
        .where('status', '=', 'UNKNOWN')
        .orderBy('updated_at', 'asc')
        .execute();
    });
  }

  public async getReview(
    actor: UserSessionPrincipal,
    runId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      const review = await transaction
        .selectFrom('review_runs')
        .selectAll()
        .where('id', '=', runId)
        .where('organization_id', '=', actor.organizationId)
        .executeTakeFirst();
      if (review === undefined)
        throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review was not found.');
      await this.assertProjectPermission(transaction, actor, review.project_id, 'review:read');
      return review;
    });
  }

  public async listFindings(
    actor: UserSessionPrincipal,
    runId: string,
  ): Promise<readonly unknown[]> {
    const review = await this.getReview(actor, runId);
    const projectId = String(review.project_id);
    return withTenant(this.database, actor.organizationId, (transaction) =>
      transaction
        .selectFrom('review_findings')
        .selectAll()
        .where('run_id', '=', runId)
        .where('project_id', '=', projectId)
        .orderBy('severity', 'asc')
        .orderBy('confidence', 'desc')
        .execute(),
    );
  }

  public async listArtifacts(
    actor: UserSessionPrincipal,
    runId: string,
  ): Promise<readonly unknown[]> {
    const review = await this.getReview(actor, runId);
    const projectId = String(review.project_id);
    return withTenant(this.database, actor.organizationId, (transaction) =>
      transaction
        .selectFrom('artifacts')
        .select([
          'id',
          'artifact_type as artifactType',
          'content_hash as contentHash',
          'media_type as mediaType',
          'size_bytes as sizeBytes',
          'retention_until as retentionUntil',
          'created_at as createdAt',
        ])
        .where('run_id', '=', runId)
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'asc')
        .execute(),
    );
  }

  public async getArtifactForDownload(
    actor: UserSessionPrincipal,
    artifactId: string,
  ): Promise<
    Readonly<{
      artifactType: string;
      contentHash: string;
      mediaType: string;
      objectKey: string;
      sizeBytes: string;
    }>
  > {
    return withTenant(this.database, actor.organizationId, async (transaction) => {
      const artifact = await transaction
        .selectFrom('artifacts')
        .select([
          'artifact_type as artifactType',
          'content_hash as contentHash',
          'media_type as mediaType',
          'object_key as objectKey',
          'project_id as projectId',
          'size_bytes as sizeBytes',
        ])
        .where('id', '=', artifactId)
        .where('organization_id', '=', actor.organizationId)
        .executeTakeFirst();
      if (artifact === undefined)
        throw new HttpError(404, 'ARTIFACT_NOT_FOUND', 'Artifact was not found.');
      await this.assertProjectPermission(transaction, actor, artifact.projectId, 'artifact:read');
      return artifact;
    });
  }

  public async listRunEvents(
    actor: UserSessionPrincipal,
    runId: string,
    afterId: number,
  ): Promise<readonly unknown[]> {
    await this.getReview(actor, runId);
    return withTenant(this.database, actor.organizationId, (transaction) =>
      transaction
        .selectFrom('run_events')
        .select(['id', 'event_type as eventType', 'payload', 'occurred_at as occurredAt'])
        .where('run_id', '=', runId)
        .where('id', '>', afterId)
        .orderBy('id', 'asc')
        .limit(100)
        .execute(),
    );
  }

  public async acceptGitHubWebhook(
    input: Readonly<{
      action?: string;
      baseSha?: string;
      deliveryId: string;
      eventName: string;
      headSha?: string;
      installationId?: string;
      payloadHash: string;
      pullRequestNumber?: number;
      repositoryId?: string;
      traceId: string;
    }>,
  ): Promise<Readonly<{ duplicate: boolean; runId?: string }>> {
    return this.database.transaction().execute(async (transaction) => {
      const existingDelivery = await transaction
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('provider', '=', 'github')
        .where('delivery_id', '=', input.deliveryId)
        .executeTakeFirst();
      if (existingDelivery !== undefined) return { duplicate: true };
      const delivery = await transaction
        .insertInto('webhook_deliveries')
        .values({
          delivery_id: input.deliveryId,
          error_code: null,
          event_name: input.eventName,
          payload_hash: input.payloadHash,
          processed_at: null,
          provider: 'github',
          status: 'RECEIVED',
        })
        .onConflict((conflict) => conflict.columns(['provider', 'delivery_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (delivery === undefined) return { duplicate: true };
      if (
        input.eventName !== 'pull_request' ||
        input.action === undefined ||
        !['opened', 'reopened', 'synchronize'].includes(input.action)
      ) {
        await transaction
          .updateTable('webhook_deliveries')
          .set({ processed_at: new Date(), status: 'IGNORED' })
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow();
        return { duplicate: false };
      }
      if (
        input.baseSha === undefined ||
        input.headSha === undefined ||
        input.installationId === undefined ||
        input.pullRequestNumber === undefined ||
        input.repositoryId === undefined
      ) {
        throw new HttpError(
          400,
          'GITHUB_PULL_REQUEST_PAYLOAD_INVALID',
          'Pull request webhook fields are missing.',
        );
      }
      const repository = await transaction
        .selectFrom('repository_connections')
        .innerJoin('projects', 'projects.id', 'repository_connections.project_id')
        .select([
          'repository_connections.id',
          'repository_connections.organization_id',
          'repository_connections.project_id',
          'projects.default_ruleset_version_id',
        ])
        .where('repository_connections.installation_id', '=', input.installationId)
        .where('repository_connections.repository_id', '=', input.repositoryId)
        .where('repository_connections.status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (repository?.default_ruleset_version_id === null || repository === undefined) {
        await transaction
          .updateTable('webhook_deliveries')
          .set({
            error_code: 'REPOSITORY_OR_RULESET_NOT_READY',
            processed_at: new Date(),
            status: 'IGNORED',
          })
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow();
        return { duplicate: false };
      }
      const existingRun = await transaction
        .selectFrom('review_runs')
        .select('id')
        .where('repository_connection_id', '=', repository.id)
        .where('pull_request_number', '=', input.pullRequestNumber)
        .where('head_sha', '=', input.headSha)
        .where('ruleset_version_id', '=', repository.default_ruleset_version_id)
        .where('rerun_of_run_id', 'is', null)
        .executeTakeFirst();
      if (existingRun !== undefined) {
        await transaction
          .updateTable('webhook_deliveries')
          .set({ processed_at: new Date(), status: 'PROCESSED' })
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow();
        return { duplicate: false, runId: existingRun.id };
      }
      const candidateRunId = randomUUID();
      const actor: SystemPrincipal = {
        organizationId: repository.organization_id,
        systemId: 'github-webhook',
        type: 'SYSTEM',
      };
      const insertedRun = await transaction
        .insertInto('review_runs')
        .values({
          base_sha: input.baseSha,
          completed_at: null,
          coverage_complete: false,
          diff_hash: null,
          head_sha: input.headSha,
          id: candidateRunId,
          model: 'deepseek-v4-flash',
          organization_id: repository.organization_id,
          project_id: repository.project_id,
          prompt_version: 'review-v1',
          pull_request_number: input.pullRequestNumber,
          repository_connection_id: repository.id,
          request_idempotency_key: `github:${input.deliveryId}`,
          rerun_of_run_id: null,
          ruleset_version_id: repository.default_ruleset_version_id,
          started_at: null,
          status: 'ACCEPTED',
          version: 0,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (insertedRun === undefined) {
        const concurrentRun = await transaction
          .selectFrom('review_runs')
          .select('id')
          .where('repository_connection_id', '=', repository.id)
          .where('pull_request_number', '=', input.pullRequestNumber)
          .where('head_sha', '=', input.headSha)
          .where('ruleset_version_id', '=', repository.default_ruleset_version_id)
          .where('rerun_of_run_id', 'is', null)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('webhook_deliveries')
          .set({ processed_at: new Date(), status: 'PROCESSED' })
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow();
        return { duplicate: false, runId: concurrentRun.id };
      }
      const runId = insertedRun.id;
      await transaction
        .insertInto('run_events')
        .values({
          event_type: 'review.accepted',
          organization_id: repository.organization_id,
          payload: { source: 'github_webhook', status: 'ACCEPTED' },
          project_id: repository.project_id,
          run_id: runId,
        })
        .executeTakeFirstOrThrow();
      const task = await transaction
        .insertInto('tasks')
        .values({
          attempt_count: 0,
          available_at: new Date(),
          max_attempts: 3,
          organization_id: repository.organization_id,
          project_id: repository.project_id,
          run_id: runId,
          status: 'PENDING',
          task_type: 'ACQUIRE_SOURCE',
          version: 0,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await insertOutboxEvent(transaction, {
        correlationId: input.traceId,
        eventId: randomUUID(),
        eventType: 'review.acquire.requested',
        organizationId: repository.organization_id,
        payload: { runId, taskId: task.id },
        projectId: repository.project_id,
      });
      await this.audit(
        transaction,
        actor,
        'review.accepted',
        'REVIEW_RUN',
        runId,
        input.traceId,
        repository.project_id,
        { deliveryId: input.deliveryId },
      );
      await transaction
        .updateTable('webhook_deliveries')
        .set({ processed_at: new Date(), status: 'PROCESSED' })
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow();
      return { duplicate: false, runId };
    });
  }

  private async insertAcceptedReview(
    transaction: DeliveryTransaction,
    actor: UserSessionPrincipal | ProjectTokenPrincipal,
    projectId: string,
    trigger: ReviewTrigger,
    idempotencyKey: string,
    traceId: string,
  ): Promise<Readonly<{ runId: string; status: 'ACCEPTED' }>> {
    const existing = await transaction
      .selectFrom('review_runs')
      .select('id')
      .where('project_id', '=', projectId)
      .where('request_idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing !== undefined) return { runId: existing.id, status: 'ACCEPTED' };

    const project = await transaction
      .selectFrom('projects')
      .select('default_ruleset_version_id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (project === undefined)
      throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found.');
    const rulesetVersionId = trigger.rulesetVersionId ?? project.default_ruleset_version_id;
    if (rulesetVersionId === null) {
      throw new HttpError(
        409,
        'RULESET_REQUIRED',
        'Publish a default ruleset before triggering review.',
      );
    }
    const publishedRuleset = await transaction
      .selectFrom('ruleset_versions')
      .select('id')
      .where('id', '=', rulesetVersionId)
      .where('project_id', '=', projectId)
      .where('status', '=', 'PUBLISHED')
      .executeTakeFirst();
    if (publishedRuleset === undefined) {
      throw new HttpError(
        409,
        'RULESET_NOT_PUBLISHED',
        'Review requires a published ruleset version.',
      );
    }
    const repository = await transaction
      .selectFrom('repository_connections')
      .select('id')
      .where('id', '=', trigger.source.repositoryConnectionId)
      .where('project_id', '=', projectId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (repository === undefined) {
      throw new HttpError(
        404,
        'REPOSITORY_CONNECTION_NOT_FOUND',
        'Repository connection was not found.',
      );
    }
    const candidateRunId = randomUUID();
    const insertedRun = await transaction
      .insertInto('review_runs')
      .values({
        base_sha: null,
        completed_at: null,
        coverage_complete: false,
        diff_hash: null,
        head_sha: null,
        id: candidateRunId,
        model: 'deepseek-v4-flash',
        organization_id: actor.organizationId,
        project_id: projectId,
        prompt_version: 'review-v1',
        pull_request_number: trigger.source.pullRequestNumber,
        repository_connection_id: trigger.source.repositoryConnectionId,
        request_idempotency_key: idempotencyKey,
        rerun_of_run_id: trigger.rerunOfRunId ?? null,
        ruleset_version_id: rulesetVersionId,
        started_at: null,
        status: 'ACCEPTED',
        version: 0,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (insertedRun === undefined) {
      const concurrentRun = await transaction
        .selectFrom('review_runs')
        .select('id')
        .where('project_id', '=', projectId)
        .where('request_idempotency_key', '=', idempotencyKey)
        .executeTakeFirstOrThrow();
      return { runId: concurrentRun.id, status: 'ACCEPTED' };
    }
    const runId = insertedRun.id;
    await transaction
      .insertInto('run_events')
      .values({
        event_type: 'review.accepted',
        organization_id: actor.organizationId,
        payload: { status: 'ACCEPTED' },
        project_id: projectId,
        run_id: runId,
      })
      .executeTakeFirstOrThrow();
    const task = await transaction
      .insertInto('tasks')
      .values({
        attempt_count: 0,
        available_at: new Date(),
        max_attempts: 3,
        organization_id: actor.organizationId,
        project_id: projectId,
        run_id: runId,
        status: 'PENDING',
        task_type: 'ACQUIRE_SOURCE',
        version: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await insertOutboxEvent(transaction, {
      correlationId: traceId,
      eventId: randomUUID(),
      eventType: 'review.acquire.requested',
      organizationId: actor.organizationId,
      payload: { runId, taskId: task.id },
      projectId,
    });
    await this.audit(
      transaction,
      actor,
      'review.accepted',
      'REVIEW_RUN',
      runId,
      traceId,
      projectId,
    );
    return { runId, status: 'ACCEPTED' };
  }

  private async assertOrganizationPermission(
    transaction: DeliveryTransaction,
    actor: UserSessionPrincipal,
    permission: Permission,
  ): Promise<void> {
    const membership = await transaction
      .selectFrom('organization_members')
      .select('role')
      .where('organization_id', '=', actor.organizationId)
      .where('user_id', '=', actor.userId)
      .executeTakeFirst();
    if (
      membership === undefined ||
      !hasPermission({ organizationRole: membership.role, permission })
    ) {
      throw new HttpError(
        403,
        'ORGANIZATION_ACCESS_DENIED',
        'Organization permission is required.',
      );
    }
  }

  private async assertProjectPermission(
    transaction: DeliveryTransaction,
    actor: UserSessionPrincipal,
    projectId: string,
    permission: Permission,
  ): Promise<void> {
    const membership = await transaction
      .selectFrom('organization_members')
      .leftJoin('project_members', (join) =>
        join
          .onRef('project_members.organization_id', '=', 'organization_members.organization_id')
          .onRef('project_members.user_id', '=', 'organization_members.user_id')
          .on('project_members.project_id', '=', projectId),
      )
      .select([
        'organization_members.role as organizationRole',
        'project_members.role as projectRole',
      ])
      .where('organization_members.organization_id', '=', actor.organizationId)
      .where('organization_members.user_id', '=', actor.userId)
      .executeTakeFirst();
    if (
      membership === undefined ||
      !hasPermission({
        organizationRole: membership.organizationRole,
        permission,
        ...(membership.projectRole === null ? {} : { projectRole: membership.projectRole }),
      })
    ) {
      throw new HttpError(403, 'PROJECT_ACCESS_DENIED', 'Project permission is required.');
    }
  }

  private async audit(
    transaction: DeliveryTransaction,
    actor: UserSessionPrincipal | ProjectTokenPrincipal | SystemPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    traceId: string,
    projectId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await transaction
      .insertInto('audit_events')
      .values({
        action,
        actor_id: principalId(actor),
        actor_type: actor.type,
        metadata: { ...principalAuditMetadata(actor), ...metadata },
        organization_id: actor.organizationId,
        project_id: projectId,
        target_id: targetId,
        target_type: targetType,
        trace_id: traceId,
      })
      .executeTakeFirstOrThrow();
  }

  private requireKeyEncryptionKey(): Buffer {
    if (this.keyEncryptionKey === undefined) {
      throw new HttpError(503, 'SECRET_VAULT_NOT_CONFIGURED', 'Secret vault is not configured.');
    }
    return this.keyEncryptionKey;
  }
}
