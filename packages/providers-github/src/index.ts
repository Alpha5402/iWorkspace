import { createHmac, timingSafeEqual } from 'node:crypto';

import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', webhookSecret).update(rawBody).digest('hex'));
  const received = Buffer.from(signatureHeader.slice('sha256='.length));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const InstallationTokenResponseSchema = z.object({
  expires_at: z.string(),
  permissions: z.record(z.string(), z.string()).default({}),
  token: z.string().min(1),
});

const RepositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});

const PullRequestSchema = z.object({
  base: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
});

const CheckRunResponseSchema = z.object({ id: z.number().int().positive() });
const CheckRunsResponseSchema = z.object({
  check_runs: z.array(
    z.object({ external_id: z.string().nullable().optional(), id: z.number().int().positive() }),
  ),
});

export type GitHubCheckAnnotation = Readonly<{
  annotation_level: 'failure' | 'warning' | 'notice';
  end_line: number;
  message: string;
  path: string;
  start_line: number;
  title: string;
}>;

export type GitHubCheckConclusion =
  'success' | 'failure' | 'neutral' | 'action_required' | 'cancelled' | 'timed_out';

export class GitHubProviderError extends Error {
  public constructor(
    public readonly code: 'AUTHENTICATION' | 'NOT_FOUND' | 'RATE_LIMITED' | 'PROVIDER_FAILURE',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubProviderError';
  }
}

type FetchLike = typeof fetch;

export class GitHubAppProvider {
  public constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly fetchImplementation: FetchLike = fetch,
    private readonly apiBaseUrl = 'https://api.github.com',
  ) {}

  public async createInstallationToken(installationId: string): Promise<
    Readonly<{
      expiresAt: string;
      permissions: Readonly<Record<string, string>>;
      token: string;
    }>
  > {
    const appJwt = await this.createAppJwt();
    const response = await this.request(
      `/app/installations/${installationId}/access_tokens`,
      { method: 'POST' },
      appJwt,
    );
    const parsed = InstallationTokenResponseSchema.parse(await response.json());
    return { expiresAt: parsed.expires_at, permissions: parsed.permissions, token: parsed.token };
  }

  public async getRepository(
    repositoryId: string,
    installationToken: string,
  ): Promise<Readonly<{ id: string; name: string; owner: string }>> {
    const response = await this.request(`/repositories/${repositoryId}`, {}, installationToken);
    const repository = RepositorySchema.parse(await response.json());
    return { id: String(repository.id), name: repository.name, owner: repository.owner.login };
  }

  public async getPullRequestSnapshot(
    input: Readonly<{
      installationToken: string;
      owner: string;
      pullRequestNumber: number;
      repository: string;
    }>,
  ): Promise<Readonly<{ baseSha: string; diff: string; headSha: string }>> {
    const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}`;
    const metadataResponse = await this.request(path, {}, input.installationToken);
    const metadata = PullRequestSchema.parse(await metadataResponse.json());
    const diffResponse = await this.request(
      path,
      { headers: { Accept: 'application/vnd.github.v3.diff' } },
      input.installationToken,
    );
    return {
      baseSha: metadata.base.sha,
      diff: await diffResponse.text(),
      headSha: metadata.head.sha,
    };
  }

  public async getPullRequestHead(
    input: Readonly<{
      installationToken: string;
      owner: string;
      pullRequestNumber: number;
      repository: string;
    }>,
  ): Promise<string> {
    const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}`;
    const response = await this.request(path, {}, input.installationToken);
    return PullRequestSchema.parse(await response.json()).head.sha;
  }

  public async createCheckRun(
    input: Readonly<{
      annotations: readonly GitHubCheckAnnotation[];
      conclusion: GitHubCheckConclusion;
      detailsUrl: string;
      externalId: string;
      headSha: string;
      installationToken: string;
      name: string;
      owner: string;
      repository: string;
      summary: string;
      title: string;
    }>,
  ): Promise<string> {
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/check-runs`,
      {
        body: JSON.stringify({
          conclusion: input.conclusion,
          details_url: input.detailsUrl,
          external_id: input.externalId,
          head_sha: input.headSha,
          name: input.name,
          output: {
            annotations: input.annotations.slice(0, 50),
            summary: input.summary,
            title: input.title,
          },
          status: 'completed',
        }),
        method: 'POST',
      },
      input.installationToken,
    );
    return String(CheckRunResponseSchema.parse(await response.json()).id);
  }

  public async findCheckRunByExternalId(
    input: Readonly<{
      externalId: string;
      headSha: string;
      installationToken: string;
      owner: string;
      repository: string;
    }>,
  ): Promise<string | undefined> {
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${input.headSha}/check-runs?per_page=100`,
      {},
      input.installationToken,
    );
    const checks = CheckRunsResponseSchema.parse(await response.json());
    const match = checks.check_runs.find((check) => check.external_id === input.externalId);
    return match === undefined ? undefined : String(match.id);
  }

  private async createAppJwt(now = new Date()): Promise<string> {
    const key = await importPKCS8(this.privateKeyPem, 'RS256');
    const issuedAt = Math.floor(now.getTime() / 1_000) - 30;
    return new SignJWT()
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.appId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 9 * 60)
      .sign(key);
  }

  private async request(path: string, init: RequestInit, token: string): Promise<Response> {
    let response: Response;
    try {
      const headers = new Headers({
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'iWorkspace-review-app',
        'X-GitHub-Api-Version': '2022-11-28',
      });
      new Headers(init.headers).forEach((value, name) => {
        headers.set(name, value);
      });
      response = await this.fetchImplementation(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new GitHubProviderError('PROVIDER_FAILURE', 'GitHub request failed before a response.');
    }
    if (response.ok) return response;
    const code =
      response.status === 401 || response.status === 403
        ? response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
          ? 'RATE_LIMITED'
          : 'AUTHENTICATION'
        : response.status === 404
          ? 'NOT_FOUND'
          : 'PROVIDER_FAILURE';
    throw new GitHubProviderError(
      code,
      `GitHub returned HTTP ${response.status}.`,
      response.status,
    );
  }
}
