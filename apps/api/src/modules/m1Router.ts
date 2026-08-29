import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  ProjectTokenScopeSchema,
  ReviewTriggerSchema,
  RuleDefinitionSchema,
} from '@delivery/contracts';
import { type GitHubAppProvider, verifyGitHubWebhookSignature } from '@delivery/providers-github';
import { type ImmutableArtifactStore } from '@delivery/object-storage';
import { validateCsrf } from '@delivery/security';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';

import {
  type AuthService,
  type SessionBundle,
  type UserActor,
} from '../application/authService.js';
import { type AdminService } from '../application/adminService.js';
import {
  type ControlPlaneService,
  type ProjectTokenActor,
} from '../application/controlPlaneService.js';
import { type RegistrationService } from '../application/registrationService.js';
import { HttpError } from '../errors.js';
import { getResponseTraceId } from '../middleware/requestContext.js';
import { getRawBody } from '../middleware/rawBody.js';

const LoginSchema = z.object({
  email: z.email(),
  organizationId: z.uuid().optional(),
  password: z.string().min(12),
});
const RegistrationSchema = z.object({
  email: z.email(),
  password: z.string().min(12),
});
const AdminUserListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  email: z.email().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  platformRole: z.enum(['SUPER_ADMIN', 'ADMIN', 'USER']).optional(),
  status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED']).optional(),
});
const ReasonSchema = z.string().trim().min(3).max(500);
const ProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
});
const ProjectTokenSchema = z.object({
  expiresAt: z.iso.datetime().optional(),
  name: z.string().trim().min(1).max(120),
  scopes: z.array(ProjectTokenScopeSchema).min(1),
});
const RulesetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rules: z.array(RuleDefinitionSchema).min(1),
});
const RepositoryConnectionSchema = z.object({
  installationId: z.string().regex(/^\d+$/),
  repositoryId: z.string().regex(/^\d+$/),
});
const SecretSchema = z.object({
  name: z.string().trim().min(1).max(120),
  value: z.string().min(1),
});
const InvitationSchema = z.object({
  email: z.email(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).default('MEMBER'),
});
const GitHubPullRequestWebhookSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  number: z.number().int().positive(),
  pull_request: z.object({
    base: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  }),
  repository: z.object({ id: z.number().int().positive() }),
});

const GitHubWebhookBaseSchema = z.looseObject({ action: z.string().optional() });

function createGitHubState(projectId: string, userId: string, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ expiresAt: Date.now() + 10 * 60 * 1_000, projectId, userId }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyGitHubState(state: string, userId: string, secret: string): string {
  const [payload, signature, extra] = state.split('.');
  if (payload === undefined || signature === undefined || extra !== undefined) {
    throw new HttpError(400, 'GITHUB_STATE_INVALID', 'GitHub installation state is invalid.');
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new HttpError(400, 'GITHUB_STATE_INVALID', 'GitHub installation state is invalid.');
  }
  const decoded = z
    .object({ expiresAt: z.number().int(), projectId: z.uuid(), userId: z.uuid() })
    .parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
  if (decoded.userId !== userId || decoded.expiresAt <= Date.now()) {
    throw new HttpError(
      400,
      'GITHUB_STATE_EXPIRED',
      'GitHub installation state expired or changed user.',
    );
  }
  return decoded.projectId;
}

export type M1Runtime = Readonly<{
  admin: Pick<
    AdminService,
    'getUser' | 'listUsers' | 'revokeUserSessions' | 'setPlatformRole' | 'setUserStatus'
  >;
  auth: Pick<
    AuthService,
    | 'acceptInvitation'
    | 'listOrganizations'
    | 'listSessions'
    | 'login'
    | 'logout'
    | 'logoutAllSessions'
    | 'logoutOtherSessions'
    | 'refresh'
    | 'revokeSession'
    | 'switchOrganization'
    | 'verifyAccessToken'
  >;
  controlPlane: Pick<
    ControlPlaneService,
    | 'acceptGitHubWebhook'
    | 'assertProjectManageAccess'
    | 'createInvitation'
    | 'createProject'
    | 'createProjectSecret'
    | 'createProjectToken'
    | 'createRepositoryConnection'
    | 'createRuleset'
    | 'disconnectRepositoryConnection'
    | 'getReview'
    | 'getArtifactForDownload'
    | 'listArtifacts'
    | 'listFindings'
    | 'listFailedTasks'
    | 'listOrganizationMembers'
    | 'listProjectMembers'
    | 'listProjectSecrets'
    | 'listProjectTokens'
    | 'listProjects'
    | 'listRepositoryConnections'
    | 'listReviews'
    | 'listRulesets'
    | 'listRunEvents'
    | 'listUnknownExternalEffects'
    | 'publishRuleset'
    | 'removeOrganizationMember'
    | 'removeProjectMember'
    | 'replayFailedTask'
    | 'revokeProjectToken'
    | 'rotateProjectSecret'
    | 'setDefaultRulesetVersion'
    | 'setProjectMember'
    | 'triggerReview'
    | 'authenticateProjectToken'
  >;
  github: Pick<GitHubAppProvider, 'createInstallationToken' | 'getRepository'>;
  artifactStore: Pick<ImmutableArtifactStore, 'get'>;
  githubAppSlug: string;
  githubWebhookSecret: string;
  registration: Pick<RegistrationService, 'register' | 'resendVerification' | 'verifyEmail'>;
  secureCookies: boolean;
  webOrigin: string;
}>;

function parseCookies(request: Request): Readonly<Record<string, string>> {
  const header = request.headers.cookie;
  if (header === undefined) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return [];
      return [
        [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())],
      ];
    }),
  );
}

function setSessionCookies(response: Response, session: SessionBundle, secure: boolean): void {
  const shared = { httpOnly: true, sameSite: 'lax' as const, secure };
  response.cookie('iw_access', session.accessToken, { ...shared, maxAge: 10 * 60 * 1_000 });
  response.cookie('iw_refresh', session.refreshToken, {
    ...shared,
    maxAge: 30 * 24 * 60 * 60 * 1_000,
    path: '/api/v1/auth',
  });
  response.cookie('iw_csrf', session.csrfToken, {
    httpOnly: false,
    maxAge: 30 * 24 * 60 * 60 * 1_000,
    sameSite: 'lax',
    secure,
  });
}

function clearSessionCookies(response: Response, secure: boolean): void {
  const shared = { httpOnly: true, sameSite: 'lax' as const, secure };
  response.clearCookie('iw_access', shared);
  response.clearCookie('iw_refresh', { ...shared, path: '/api/v1/auth' });
  response.clearCookie('iw_csrf', { httpOnly: false, sameSite: 'lax', secure });
}

async function requireUser(request: Request, runtime: M1Runtime): Promise<UserActor> {
  const token = parseCookies(request).iw_access;
  if (token === undefined)
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  try {
    return await runtime.auth.verifyAccessToken(token);
  } catch {
    throw new HttpError(401, 'ACCESS_TOKEN_INVALID', 'Access token is invalid or expired.');
  }
}

function requireCsrf(request: Request, runtime: M1Runtime): void {
  if (
    !validateCsrf({
      allowedOrigin: runtime.webOrigin,
      csrfCookie: parseCookies(request).iw_csrf,
      csrfHeader: request.header('x-csrf-token') ?? undefined,
      origin: request.header('origin') ?? undefined,
    })
  ) {
    throw new HttpError(403, 'CSRF_VALIDATION_FAILED', 'CSRF validation failed.');
  }
}

async function resolveReviewActor(
  request: Request,
  runtime: M1Runtime,
  projectId: string,
): Promise<UserActor | ProjectTokenActor> {
  const authorization = request.header('authorization');
  if (authorization?.startsWith('Bearer ') === true) {
    return runtime.controlPlane.authenticateProjectToken(
      projectId,
      authorization.slice('Bearer '.length),
      'review:trigger',
    );
  }
  requireCsrf(request, runtime);
  return requireUser(request, runtime);
}

const asyncRoute =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response).catch(next);
  };

function sessionMetadata(request: Request): Readonly<{ ipAddress: string; userAgent?: string }> {
  const userAgent = request.header('user-agent');
  return {
    ipAddress: request.ip ?? request.socket.remoteAddress ?? 'unknown',
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

export function createM1Router(runtime: M1Runtime): Router {
  const router = Router();

  router.post(
    '/integrations/github/webhooks',
    asyncRoute(async (request, response) => {
      const rawBody = getRawBody(request);
      if (rawBody === undefined) {
        throw new HttpError(400, 'RAW_BODY_REQUIRED', 'Webhook raw body is unavailable.');
      }
      if (
        !verifyGitHubWebhookSignature(
          rawBody,
          request.header('x-hub-signature-256') ?? undefined,
          runtime.githubWebhookSecret,
        )
      ) {
        throw new HttpError(
          401,
          'GITHUB_SIGNATURE_INVALID',
          'GitHub webhook signature is invalid.',
        );
      }
      const deliveryId = request.header('x-github-delivery');
      const eventName = request.header('x-github-event');
      if (deliveryId === undefined || eventName === undefined) {
        throw new HttpError(
          400,
          'GITHUB_HEADERS_REQUIRED',
          'GitHub delivery headers are required.',
        );
      }
      const basePayload = GitHubWebhookBaseSchema.parse(request.body);
      const shared = {
        ...(basePayload.action === undefined ? {} : { action: basePayload.action }),
        deliveryId,
        eventName,
        payloadHash: createHash('sha256').update(rawBody).digest('hex'),
        traceId: getResponseTraceId(response.locals),
      };
      const result =
        eventName === 'pull_request'
          ? await runtime.controlPlane.acceptGitHubWebhook(
              (() => {
                const payload = GitHubPullRequestWebhookSchema.parse(request.body);
                return {
                  ...shared,
                  action: payload.action,
                  baseSha: payload.pull_request.base.sha,
                  headSha: payload.pull_request.head.sha,
                  installationId: String(payload.installation.id),
                  pullRequestNumber: payload.number,
                  repositoryId: String(payload.repository.id),
                };
              })(),
            )
          : await runtime.controlPlane.acceptGitHubWebhook(shared);
      response.status(202).json(result);
    }),
  );

  router.post(
    '/auth/register',
    asyncRoute(async (request, response) => {
      const payload = RegistrationSchema.parse(request.body);
      const result = await runtime.registration.register({
        ...payload,
        ipAddress: sessionMetadata(request).ipAddress,
      });
      response.status(202).json(result);
    }),
  );

  router.post(
    '/auth/verify-email',
    asyncRoute(async (request, response) => {
      const payload = z.object({ token: z.string().min(20) }).parse(request.body);
      response.status(200).json(await runtime.registration.verifyEmail(payload.token));
    }),
  );

  router.post(
    '/auth/resend-verification',
    asyncRoute(async (request, response) => {
      const payload = z.object({ email: z.email() }).parse(request.body);
      const result = await runtime.registration.resendVerification({
        email: payload.email,
        ipAddress: sessionMetadata(request).ipAddress,
      });
      response.status(202).json(result);
    }),
  );

  router.post(
    '/auth/login',
    asyncRoute(async (request, response) => {
      const session = await runtime.auth.login({
        ...LoginSchema.parse(request.body),
        ...sessionMetadata(request),
      });
      setSessionCookies(response, session, runtime.secureCookies);
      response.status(200).json({ user: session.user });
    }),
  );

  router.post(
    '/invitations/accept',
    asyncRoute(async (request, response) => {
      const payload = z
        .object({ password: z.string().min(12), token: z.string().min(20) })
        .parse(request.body);
      const result = await runtime.auth.acceptInvitation({
        password: payload.password,
        token: payload.token,
      });
      response.status(200).json(result);
    }),
  );

  router.post(
    '/organizations/:organizationId/invitations',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const actor = await requireUser(request, runtime);
      if (actor.organizationId !== z.uuid().parse(request.params.organizationId)) {
        throw new HttpError(
          403,
          'ORGANIZATION_ACCESS_DENIED',
          'Organization does not match the session.',
        );
      }
      const invitation = await runtime.controlPlane.createInvitation(
        actor,
        InvitationSchema.parse(request.body),
        getResponseTraceId(response.locals),
      );
      response.status(201).json({ invitation });
    }),
  );

  router.get(
    '/organizations/:organizationId/members',
    asyncRoute(async (request, response) => {
      const actor = await requireUser(request, runtime);
      if (actor.organizationId !== z.uuid().parse(request.params.organizationId)) {
        throw new HttpError(
          403,
          'ORGANIZATION_ACCESS_DENIED',
          'Organization does not match the session.',
        );
      }
      response
        .status(200)
        .json({ members: await runtime.controlPlane.listOrganizationMembers(actor) });
    }),
  );

  router.delete(
    '/organizations/:organizationId/members/:userId',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const actor = await requireUser(request, runtime);
      if (actor.organizationId !== z.uuid().parse(request.params.organizationId)) {
        throw new HttpError(
          403,
          'ORGANIZATION_ACCESS_DENIED',
          'Organization does not match the session.',
        );
      }
      await runtime.controlPlane.removeOrganizationMember(
        actor,
        z.uuid().parse(request.params.userId),
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/auth/refresh',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const refreshToken = parseCookies(request).iw_refresh;
      if (refreshToken === undefined) {
        throw new HttpError(401, 'REFRESH_TOKEN_REQUIRED', 'Refresh token is required.');
      }
      const session = await runtime.auth.refresh(refreshToken, sessionMetadata(request));
      setSessionCookies(response, session, runtime.secureCookies);
      response.status(200).json({ user: session.user });
    }),
  );

  router.post(
    '/auth/logout',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.auth.logout(await requireUser(request, runtime));
      clearSessionCookies(response, runtime.secureCookies);
      response.status(204).end();
    }),
  );

  router.get(
    '/me',
    asyncRoute(async (request, response) => {
      const actor = await requireUser(request, runtime);
      response.status(200).json({ actor });
    }),
  );

  router.get(
    '/me/organizations',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        organizations: await runtime.auth.listOrganizations(await requireUser(request, runtime)),
      });
    }),
  );

  router.post(
    '/auth/switch-organization',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const payload = z.object({ organizationId: z.uuid() }).parse(request.body);
      const session = await runtime.auth.switchOrganization(
        await requireUser(request, runtime),
        payload.organizationId,
        sessionMetadata(request),
      );
      setSessionCookies(response, session, runtime.secureCookies);
      response.status(200).json({ user: session.user });
    }),
  );

  router.get(
    '/auth/sessions',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        sessions: await runtime.auth.listSessions(await requireUser(request, runtime)),
      });
    }),
  );

  router.delete(
    '/auth/sessions/:sessionId',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const result = await runtime.auth.revokeSession(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.sessionId),
      );
      if (result.currentSessionRevoked) clearSessionCookies(response, runtime.secureCookies);
      response.status(200).json(result);
    }),
  );

  router.post(
    '/auth/logout-others',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      response
        .status(200)
        .json(await runtime.auth.logoutOtherSessions(await requireUser(request, runtime)));
    }),
  );

  router.post(
    '/auth/logout-all',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const result = await runtime.auth.logoutAllSessions(await requireUser(request, runtime));
      clearSessionCookies(response, runtime.secureCookies);
      response.status(200).json(result);
    }),
  );

  router.get(
    '/admin/users',
    asyncRoute(async (request, response) => {
      response
        .status(200)
        .json(
          await runtime.admin.listUsers(
            await requireUser(request, runtime),
            AdminUserListQuerySchema.parse(request.query),
          ),
        );
    }),
  );

  router.get(
    '/admin/users/:userId',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        user: await runtime.admin.getUser(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.userId),
        ),
      });
    }),
  );

  router.patch(
    '/admin/users/:userId/status',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const payload = z
        .object({ reason: ReasonSchema, status: z.enum(['ACTIVE', 'SUSPENDED']) })
        .parse(request.body);
      response.status(200).json({
        user: await runtime.admin.setUserStatus(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.userId),
          payload.status,
          payload.reason,
          getResponseTraceId(response.locals),
        ),
      });
    }),
  );

  router.patch(
    '/admin/users/:userId/platform-role',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const payload = z
        .object({ reason: ReasonSchema, role: z.enum(['ADMIN', 'USER']) })
        .parse(request.body);
      response.status(200).json({
        user: await runtime.admin.setPlatformRole(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.userId),
          payload.role,
          payload.reason,
          getResponseTraceId(response.locals),
        ),
      });
    }),
  );

  router.post(
    '/admin/users/:userId/revoke-sessions',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const payload = z.object({ reason: ReasonSchema }).parse(request.body);
      response
        .status(200)
        .json(
          await runtime.admin.revokeUserSessions(
            await requireUser(request, runtime),
            z.uuid().parse(request.params.userId),
            payload.reason,
            getResponseTraceId(response.locals),
          ),
        );
    }),
  );

  router.get(
    '/projects',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        projects: await runtime.controlPlane.listProjects(await requireUser(request, runtime)),
      });
    }),
  );

  router.post(
    '/projects',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const project = await runtime.controlPlane.createProject(
        await requireUser(request, runtime),
        ProjectSchema.parse(request.body),
        getResponseTraceId(response.locals),
      );
      response.status(201).json({ project });
    }),
  );

  router.get(
    '/projects/:projectId/tokens',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        tokens: await runtime.controlPlane.listProjectTokens(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.get(
    '/projects/:projectId/members',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        members: await runtime.controlPlane.listProjectMembers(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.put(
    '/projects/:projectId/members/:userId',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.setProjectMember(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.userId),
        z.object({ role: z.enum(['MAINTAINER', 'REVIEWER', 'VIEWER']) }).parse(request.body).role,
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.delete(
    '/projects/:projectId/members/:userId',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.removeProjectMember(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.userId),
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/projects/:projectId/tokens',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const token = await runtime.controlPlane.createProjectToken(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        ProjectTokenSchema.parse(request.body),
        getResponseTraceId(response.locals),
      );
      response.status(201).json({ token });
    }),
  );

  router.delete(
    '/projects/:projectId/tokens/:tokenId',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.revokeProjectToken(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.tokenId),
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.get(
    '/projects/:projectId/secrets',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        secrets: await runtime.controlPlane.listProjectSecrets(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.post(
    '/projects/:projectId/secrets',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const secret = await runtime.controlPlane.createProjectSecret(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        SecretSchema.parse(request.body),
        getResponseTraceId(response.locals),
      );
      response.status(201).json({ secret });
    }),
  );

  router.post(
    '/projects/:projectId/secrets/:secretId/rotate',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.rotateProjectSecret(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.secretId),
        z.object({ value: z.string().min(1) }).parse(request.body).value,
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.get(
    '/projects/:projectId/rulesets',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        rulesets: await runtime.controlPlane.listRulesets(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.post(
    '/projects/:projectId/rulesets',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const ruleset = await runtime.controlPlane.createRuleset(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        RulesetSchema.parse(request.body),
        getResponseTraceId(response.locals),
      );
      response.status(201).json({ ruleset });
    }),
  );

  router.post(
    '/projects/:projectId/ruleset-versions/:versionId/publish',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.publishRuleset(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.versionId),
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/projects/:projectId/ruleset-versions/:versionId/default',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.setDefaultRulesetVersion(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.versionId),
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.get(
    '/integrations/github/install-url',
    asyncRoute(async (request, response) => {
      const actor = await requireUser(request, runtime);
      const projectId = z.uuid().parse(request.query.projectId);
      await runtime.controlPlane.assertProjectManageAccess(actor, projectId);
      const url = new URL(`https://github.com/apps/${runtime.githubAppSlug}/installations/new`);
      url.searchParams.set(
        'state',
        createGitHubState(projectId, actor.userId, runtime.githubWebhookSecret),
      );
      response.status(200).json({ url: url.toString() });
    }),
  );

  router.get(
    '/integrations/github/callback',
    asyncRoute(async (request, response) => {
      const actor = await requireUser(request, runtime);
      const query = z
        .object({ installation_id: z.string().regex(/^\d+$/), state: z.string().min(20) })
        .parse(request.query);
      const projectId = verifyGitHubState(query.state, actor.userId, runtime.githubWebhookSecret);
      await runtime.controlPlane.assertProjectManageAccess(actor, projectId);
      const destination = new URL(`/projects/${projectId}`, runtime.webOrigin);
      destination.searchParams.set('installationId', query.installation_id);
      response.redirect(303, destination.toString());
    }),
  );

  router.get(
    '/projects/:projectId/github-connections',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        connections: await runtime.controlPlane.listRepositoryConnections(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.post(
    '/projects/:projectId/github-connections',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      const connectionInput = RepositoryConnectionSchema.parse(request.body);
      const installation = await runtime.github.createInstallationToken(
        connectionInput.installationId,
      );
      const requiredPermissions = {
        checks: 'write',
        contents: 'read',
        pull_requests: 'read',
      } as const;
      if (
        Object.entries(requiredPermissions).some(
          ([permission, access]) => installation.permissions[permission] !== access,
        )
      ) {
        throw new HttpError(
          409,
          'GITHUB_PERMISSIONS_INSUFFICIENT',
          'GitHub App installation lacks required permissions.',
        );
      }
      const repository = await runtime.github.getRepository(
        connectionInput.repositoryId,
        installation.token,
      );
      const connection = await runtime.controlPlane.createRepositoryConnection(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        {
          installationId: connectionInput.installationId,
          owner: repository.owner,
          permissions: installation.permissions,
          repositoryId: repository.id,
          repositoryName: repository.name,
        },
        getResponseTraceId(response.locals),
      );
      response.status(201).json({ connection });
    }),
  );

  router.delete(
    '/projects/:projectId/github-connections/:connectionId',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.disconnectRepositoryConnection(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.connectionId),
        getResponseTraceId(response.locals),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/projects/:projectId/reviews',
    asyncRoute(async (request, response) => {
      const projectId = z.uuid().parse(request.params.projectId);
      const idempotencyKey = request.header('idempotency-key');
      if (
        idempotencyKey === undefined ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 200
      ) {
        throw new HttpError(
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'A valid Idempotency-Key header is required.',
        );
      }
      const review = await runtime.controlPlane.triggerReview(
        await resolveReviewActor(request, runtime, projectId),
        projectId,
        ReviewTriggerSchema.parse(request.body),
        idempotencyKey,
        getResponseTraceId(response.locals),
      );
      response.status(202).json({ review });
    }),
  );

  router.get(
    '/projects/:projectId/reviews',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        reviews: await runtime.controlPlane.listReviews(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.get(
    '/projects/:projectId/admin/failed-tasks',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        tasks: await runtime.controlPlane.listFailedTasks(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.post(
    '/projects/:projectId/admin/failed-tasks/:taskId/replay',
    asyncRoute(async (request, response) => {
      requireCsrf(request, runtime);
      await runtime.controlPlane.replayFailedTask(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.projectId),
        z.uuid().parse(request.params.taskId),
        getResponseTraceId(response.locals),
      );
      response.status(202).json({ status: 'REQUEUED' });
    }),
  );

  router.get(
    '/projects/:projectId/admin/unknown-effects',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        effects: await runtime.controlPlane.listUnknownExternalEffects(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.projectId),
        ),
      });
    }),
  );

  router.get(
    '/reviews/:runId',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        review: await runtime.controlPlane.getReview(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.runId),
        ),
      });
    }),
  );

  router.get(
    '/reviews/:runId/findings',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        findings: await runtime.controlPlane.listFindings(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.runId),
        ),
      });
    }),
  );

  router.get(
    '/reviews/:runId/artifacts',
    asyncRoute(async (request, response) => {
      response.status(200).json({
        artifacts: await runtime.controlPlane.listArtifacts(
          await requireUser(request, runtime),
          z.uuid().parse(request.params.runId),
        ),
      });
    }),
  );

  router.get(
    '/artifacts/:artifactId/download',
    asyncRoute(async (request, response) => {
      const artifact = await runtime.controlPlane.getArtifactForDownload(
        await requireUser(request, runtime),
        z.uuid().parse(request.params.artifactId),
      );
      const body = await runtime.artifactStore.get(artifact.objectKey);
      if (
        body.byteLength !== Number(artifact.sizeBytes) ||
        createHash('sha256').update(body).digest('hex') !== artifact.contentHash
      ) {
        throw new HttpError(
          503,
          'ARTIFACT_SIZE_MISMATCH',
          'Stored artifact failed integrity verification.',
        );
      }
      response.set({
        'Content-Disposition': `attachment; filename="${artifact.artifactType.replaceAll('/', '_')}"`,
        'Content-Type': artifact.mediaType,
      });
      response.status(200).send(body);
    }),
  );

  router.get(
    '/reviews/:runId/events',
    asyncRoute(async (request, response) => {
      const actor = await requireUser(request, runtime);
      const runId = z.uuid().parse(request.params.runId);
      const afterId = z.coerce
        .number()
        .int()
        .nonnegative()
        .catch(0)
        .parse(request.header('last-event-id'));
      response.set({
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      response.flushHeaders();
      let cursor = afterId;
      const deadline = Date.now() + 25_000;
      while (!request.destroyed && Date.now() < deadline) {
        const events = z
          .array(
            z.object({ eventType: z.string(), id: z.coerce.number().int(), payload: z.unknown() }),
          )
          .parse(await runtime.controlPlane.listRunEvents(actor, runId, cursor));
        for (const event of events) {
          response.write(
            `id: ${String(event.id)}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`,
          );
          cursor = event.id;
        }
        if (events.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      if (!request.destroyed) {
        response.write(': reconnect\n\n');
        response.end();
      }
    }),
  );

  return router;
}
