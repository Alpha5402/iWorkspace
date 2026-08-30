import { ErrorResponseSchema, type ErrorResponse } from '@delivery/contracts';

export class ApiClientError extends Error {
  public constructor(
    public readonly status: number,
    public readonly response: ErrorResponse,
  ) {
    super(response.error.message);
    this.name = 'ApiClientError';
  }
}

export type ProjectSummary = Readonly<{ id: string; name: string; role: string; slug: string }>;
export type ReviewSummary = Readonly<{
  completedAt: string | null;
  coverageComplete: boolean;
  createdAt: string;
  headSha: string | null;
  id: string;
  pullRequestNumber: number;
  status: string;
}>;
export type RulesetVersionSummary = Readonly<{
  contentHash: string;
  name: string;
  rules: unknown;
  rulesetId: string;
  status: 'DRAFT' | 'PUBLISHED';
  version: number;
  versionId: string;
}>;
export type OrganizationSummary = Readonly<{
  current: boolean;
  id: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}>;
export type SessionSummary = Readonly<{
  active: boolean;
  createdAt: string;
  current: boolean;
  expiresAt: string;
  familyId: string;
  ipAddress?: string;
  lastSeenAt: string;
  organizationId: string;
  sessionId: string;
  signingKeyId: string;
  userAgent?: string;
}>;
export type PlatformUserSummary = Readonly<{
  createdAt: string;
  email: string;
  id: string;
  platformRole: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED';
  updatedAt: string;
}>;
export type PlatformUserDetail = PlatformUserSummary &
  Readonly<{
    memberships: readonly Readonly<{
      organizationId: string;
      organizationName: string;
      role: 'OWNER' | 'ADMIN' | 'MEMBER';
    }>[];
    sessions: readonly SessionSummary[];
    tokens: readonly Readonly<{
      createdAt: string;
      expiresAt?: string;
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      revokedAt?: string;
      scopes: readonly string[];
      tokenPrefix: string;
    }>[];
  }>;
export type AdministratorInvitationSummary = Readonly<{
  acceptedAt?: string;
  acceptedUserId?: string;
  createdAt: string;
  createdBy: string;
  delivery: Readonly<{
    errorCode?: string;
    sentAt?: string;
    status: 'PENDING' | 'CLAIMED' | 'RETRY_WAIT' | 'SENT' | 'FAILED';
  }>;
  email: string;
  expiresAt: string;
  id: string;
  revokedAt?: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  targetRole: 'ADMIN';
}>;

export type ApiClient = Readonly<{
  acceptAdministratorInvitation(token: string, password: string): Promise<void>;
  register(email: string, password: string): Promise<void>;
  resendVerification(email: string): Promise<void>;
  verifyEmail(token: string): Promise<Readonly<{ organizationId: string }>>;
  createProject(input: Readonly<{ name: string; slug: string }>): Promise<ProjectSummary>;
  createRepositoryConnection(projectId: string, input: Record<string, unknown>): Promise<void>;
  createRuleset(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<Readonly<{ rulesetId: string; versionId: string }>>;
  createRulesetVersion(
    projectId: string,
    rulesetId: string,
    input: Record<string, unknown>,
  ): Promise<Readonly<{ version: number; versionId: string }>>;
  createToken(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<Readonly<Record<string, unknown>>>;
  disconnectRepositoryConnection(projectId: string, connectionId: string): Promise<void>;
  acceptInvitation(token: string, password: string): Promise<void>;
  artifactDownloadUrl(artifactId: string): string;
  eventUrl(runId: string): string;
  getCapability(path: string): Promise<never>;
  getReview(runId: string): Promise<Readonly<Record<string, unknown>>>;
  getGitHubInstallUrl(projectId: string): Promise<string>;
  listArtifacts(runId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  listFindings(runId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  listProjects(): Promise<readonly ProjectSummary[]>;
  listRepositoryConnections(
    projectId: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  listReviews(projectId: string): Promise<readonly ReviewSummary[]>;
  listRulesets(projectId: string): Promise<readonly RulesetVersionSummary[]>;
  listTokens(projectId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  listOrganizations(): Promise<readonly OrganizationSummary[]>;
  listSessions(): Promise<readonly SessionSummary[]>;
  switchOrganization(organizationId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<Readonly<{ currentSessionRevoked: boolean }>>;
  logoutOtherSessions(): Promise<Readonly<{ revokedFamilies: number }>>;
  logoutAllSessions(): Promise<Readonly<{ revokedFamilies: number }>>;
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<Readonly<{ revokedFamilies: number }>>;
  createAdministratorInvitation(
    email: string,
    reason: string,
  ): Promise<Readonly<{ duplicate: boolean; invitation: AdministratorInvitationSummary }>>;
  getCurrentActor(): Promise<
    Readonly<{ organizationId: string; sessionId: string; type: 'USER_SESSION'; userId: string }>
  >;
  listPlatformUsers(
    input?: Readonly<{
      cursor?: string;
      email?: string;
      limit?: number;
      platformRole?: PlatformUserSummary['platformRole'];
      status?: PlatformUserSummary['status'];
    }>,
  ): Promise<Readonly<{ nextCursor?: string; users: readonly PlatformUserSummary[] }>>;
  getPlatformUser(userId: string): Promise<PlatformUserDetail>;
  listAdministratorInvitations(
    input?: Readonly<{
      cursor?: string;
      limit?: number;
      status?: AdministratorInvitationSummary['status'];
    }>,
  ): Promise<
    Readonly<{
      invitations: readonly AdministratorInvitationSummary[];
      nextCursor?: string;
    }>
  >;
  setPlatformUserStatus(
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string,
  ): Promise<PlatformUserSummary>;
  setPlatformUserRole(
    userId: string,
    role: 'ADMIN' | 'USER',
    reason: string,
  ): Promise<PlatformUserSummary>;
  revokePlatformUserSessions(
    userId: string,
    reason: string,
  ): Promise<Readonly<{ revokedFamilies: number }>>;
  resendAdministratorInvitation(
    invitationId: string,
    reason: string,
  ): Promise<AdministratorInvitationSummary>;
  revokeAdministratorInvitation(
    invitationId: string,
    reason: string,
  ): Promise<AdministratorInvitationSummary>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  publishRuleset(projectId: string, versionId: string): Promise<void>;
  updateRulesetDraft(
    projectId: string,
    versionId: string,
    input: Record<string, unknown>,
  ): Promise<Readonly<{ contentHash: string; versionId: string }>>;
  setDefaultRulesetVersion(projectId: string, versionId: string): Promise<void>;
  triggerReview(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<Readonly<{ runId: string; status: string }>>;
}>;

function csrfToken(documentCookie: string): string | undefined {
  return documentCookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('iw_csrf='))
    ?.slice('iw_csrf='.length);
}

export function createApiClient(
  fetchImplementation: typeof fetch = fetch,
  baseUrl: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
): ApiClient {
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET';
    const csrf = typeof document === 'undefined' ? undefined : csrfToken(document.cookie);
    const headers = new Headers({
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' || method === 'HEAD' || csrf === undefined
        ? {}
        : { 'x-csrf-token': csrf }),
    });
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const response = await fetchImplementation(`${baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    });
    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json();
    if (!response.ok) throw new ApiClientError(response.status, ErrorResponseSchema.parse(body));
    return body as T;
  };

  return {
    async acceptAdministratorInvitation(token, password) {
      await request('/auth/administrator-invitations/accept', {
        body: JSON.stringify({ password, token }),
        method: 'POST',
      });
    },
    async register(email, password) {
      await request('/auth/register', {
        body: JSON.stringify({ email, password }),
        method: 'POST',
      });
    },
    async resendVerification(email) {
      await request('/auth/resend-verification', {
        body: JSON.stringify({ email }),
        method: 'POST',
      });
    },
    async verifyEmail(token) {
      return request('/auth/verify-email', {
        body: JSON.stringify({ token }),
        method: 'POST',
      });
    },
    async acceptInvitation(token, password) {
      await request('/invitations/accept', {
        body: JSON.stringify({ password, token }),
        method: 'POST',
      });
    },
    artifactDownloadUrl(artifactId) {
      return `${baseUrl}/artifacts/${artifactId}/download`;
    },
    async createProject(input) {
      return (
        await request<{ project: ProjectSummary }>('/projects', {
          body: JSON.stringify(input),
          method: 'POST',
        })
      ).project;
    },
    async createRepositoryConnection(projectId, input) {
      await request(`/projects/${projectId}/github-connections`, {
        body: JSON.stringify(input),
        method: 'POST',
      });
    },
    async createRuleset(projectId, input) {
      return (
        await request<{ ruleset: { rulesetId: string; versionId: string } }>(
          `/projects/${projectId}/rulesets`,
          {
            body: JSON.stringify(input),
            method: 'POST',
          },
        )
      ).ruleset;
    },
    async createRulesetVersion(projectId, rulesetId, input) {
      return (
        await request<{ version: { version: number; versionId: string } }>(
          `/projects/${projectId}/rulesets/${rulesetId}/versions`,
          { body: JSON.stringify(input), method: 'POST' },
        )
      ).version;
    },
    async createToken(projectId, input) {
      return (
        await request<{ token: Record<string, unknown> }>(`/projects/${projectId}/tokens`, {
          body: JSON.stringify(input),
          method: 'POST',
        })
      ).token;
    },
    async disconnectRepositoryConnection(projectId, connectionId) {
      await request(`/projects/${projectId}/github-connections/${connectionId}`, {
        method: 'DELETE',
      });
    },
    eventUrl(runId) {
      return `${baseUrl}/reviews/${runId}/events`;
    },
    async getCapability(path): Promise<never> {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      await request(normalizedPath);
      throw new Error('Capability placeholder unexpectedly succeeded.');
    },
    async getReview(runId) {
      return (await request<{ review: Record<string, unknown> }>(`/reviews/${runId}`)).review;
    },
    async getGitHubInstallUrl(projectId) {
      return (
        await request<{ url: string }>(
          `/integrations/github/install-url?projectId=${encodeURIComponent(projectId)}`,
        )
      ).url;
    },
    async listArtifacts(runId) {
      return (
        await request<{ artifacts: readonly Record<string, unknown>[] }>(
          `/reviews/${runId}/artifacts`,
        )
      ).artifacts;
    },
    async listFindings(runId) {
      return (
        await request<{ findings: readonly Record<string, unknown>[] }>(
          `/reviews/${runId}/findings`,
        )
      ).findings;
    },
    async listProjects() {
      return (await request<{ projects: readonly ProjectSummary[] }>('/projects')).projects;
    },
    async listRepositoryConnections(projectId) {
      return (
        await request<{ connections: readonly Record<string, unknown>[] }>(
          `/projects/${projectId}/github-connections`,
        )
      ).connections;
    },
    async listReviews(projectId) {
      return (
        await request<{ reviews: readonly ReviewSummary[] }>(`/projects/${projectId}/reviews`)
      ).reviews;
    },
    async listRulesets(projectId) {
      return (
        await request<{ rulesets: readonly RulesetVersionSummary[] }>(
          `/projects/${projectId}/rulesets`,
        )
      ).rulesets;
    },
    async listTokens(projectId) {
      return (
        await request<{ tokens: readonly Record<string, unknown>[] }>(
          `/projects/${projectId}/tokens`,
        )
      ).tokens;
    },
    async listOrganizations() {
      return (await request<{ organizations: readonly OrganizationSummary[] }>('/me/organizations'))
        .organizations;
    },
    async listSessions() {
      return (await request<{ sessions: readonly SessionSummary[] }>('/auth/sessions')).sessions;
    },
    async switchOrganization(organizationId) {
      await request('/auth/switch-organization', {
        body: JSON.stringify({ organizationId }),
        method: 'POST',
      });
    },
    async revokeSession(sessionId) {
      return request(`/auth/sessions/${sessionId}`, { method: 'DELETE' });
    },
    async logoutOtherSessions() {
      return request('/auth/logout-others', { method: 'POST' });
    },
    async logoutAllSessions() {
      return request('/auth/logout-all', { method: 'POST' });
    },
    async changePassword(currentPassword, newPassword) {
      return request('/auth/change-password', {
        body: JSON.stringify({ currentPassword, newPassword }),
        method: 'POST',
      });
    },
    async createAdministratorInvitation(email, reason) {
      return request('/admin/administrator-invitations', {
        body: JSON.stringify({ email, reason }),
        headers: { 'idempotency-key': crypto.randomUUID() },
        method: 'POST',
      });
    },
    async getCurrentActor() {
      return (
        await request<{
          actor: {
            organizationId: string;
            sessionId: string;
            type: 'USER_SESSION';
            userId: string;
          };
        }>('/me')
      ).actor;
    },
    async listPlatformUsers(input = {}) {
      const query = new URLSearchParams();
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      if (input.email !== undefined) query.set('email', input.email);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.platformRole !== undefined) query.set('platformRole', input.platformRole);
      if (input.status !== undefined) query.set('status', input.status);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request(`/admin/users${suffix}`);
    },
    async getPlatformUser(userId) {
      return (await request<{ user: PlatformUserDetail }>(`/admin/users/${userId}`)).user;
    },
    async listAdministratorInvitations(input = {}) {
      const query = new URLSearchParams();
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.status !== undefined) query.set('status', input.status);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request(`/admin/administrator-invitations${suffix}`);
    },
    async setPlatformUserStatus(userId, status, reason) {
      return (
        await request<{ user: PlatformUserSummary }>(`/admin/users/${userId}/status`, {
          body: JSON.stringify({ reason, status }),
          method: 'PATCH',
        })
      ).user;
    },
    async setPlatformUserRole(userId, role, reason) {
      return (
        await request<{ user: PlatformUserSummary }>(`/admin/users/${userId}/platform-role`, {
          body: JSON.stringify({ reason, role }),
          method: 'PATCH',
        })
      ).user;
    },
    async revokePlatformUserSessions(userId, reason) {
      return request(`/admin/users/${userId}/revoke-sessions`, {
        body: JSON.stringify({ reason }),
        method: 'POST',
      });
    },
    async resendAdministratorInvitation(invitationId, reason) {
      return (
        await request<{ invitation: AdministratorInvitationSummary }>(
          `/admin/administrator-invitations/${invitationId}/resend`,
          { body: JSON.stringify({ reason }), method: 'POST' },
        )
      ).invitation;
    },
    async revokeAdministratorInvitation(invitationId, reason) {
      return (
        await request<{ invitation: AdministratorInvitationSummary }>(
          `/admin/administrator-invitations/${invitationId}`,
          { body: JSON.stringify({ reason }), method: 'DELETE' },
        )
      ).invitation;
    },
    async login(email, password) {
      await request('/auth/login', { body: JSON.stringify({ email, password }), method: 'POST' });
    },
    async logout() {
      await request('/auth/logout', { method: 'POST' });
    },
    async publishRuleset(projectId, versionId) {
      await request(`/projects/${projectId}/ruleset-versions/${versionId}/publish`, {
        method: 'POST',
      });
    },
    async updateRulesetDraft(projectId, versionId, input) {
      return (
        await request<{ version: { contentHash: string; versionId: string } }>(
          `/projects/${projectId}/ruleset-versions/${versionId}`,
          { body: JSON.stringify(input), method: 'PATCH' },
        )
      ).version;
    },
    async setDefaultRulesetVersion(projectId, versionId) {
      await request(`/projects/${projectId}/ruleset-versions/${versionId}/default`, {
        method: 'POST',
      });
    },
    async triggerReview(projectId, input) {
      const result = await request<{ review: { runId: string; status: string } }>(
        `/projects/${projectId}/reviews`,
        {
          body: JSON.stringify(input),
          headers: { 'idempotency-key': crypto.randomUUID() },
          method: 'POST',
        },
      );
      return result.review;
    },
  };
}

export const apiClient = createApiClient();
