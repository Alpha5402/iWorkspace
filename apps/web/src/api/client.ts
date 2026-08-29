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

export type ApiClient = Readonly<{
  createProject(input: Readonly<{ name: string; slug: string }>): Promise<ProjectSummary>;
  createRepositoryConnection(projectId: string, input: Record<string, unknown>): Promise<void>;
  createRuleset(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<Readonly<{ rulesetId: string; versionId: string }>>;
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
  listRulesets(projectId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  listTokens(projectId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  publishRuleset(projectId: string, versionId: string): Promise<void>;
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
        await request<{ rulesets: readonly Record<string, unknown>[] }>(
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
