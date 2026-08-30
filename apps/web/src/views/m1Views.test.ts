// @vitest-environment jsdom

import { type DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Component } from 'vue';

const mocks = vi.hoisted(() => ({
  acceptAdministratorInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  artifactDownloadUrl: vi.fn((id: string) => `/artifacts/${id}`),
  changePassword: vi.fn(),
  createAdministratorInvitation: vi.fn(),
  createProject: vi.fn(),
  createRepositoryConnection: vi.fn(),
  createRuleset: vi.fn(),
  createRulesetVersion: vi.fn(),
  createToken: vi.fn(),
  disconnectRepositoryConnection: vi.fn(),
  eventUrl: vi.fn((id: string) => `/events/${id}`),
  getCurrentActor: vi.fn(),
  getGitHubInstallUrl: vi.fn(),
  getPlatformUser: vi.fn(),
  getReview: vi.fn(),
  listArtifacts: vi.fn(),
  listAdministratorInvitations: vi.fn(),
  listFindings: vi.fn(),
  listOrganizations: vi.fn(),
  listPlatformUsers: vi.fn(),
  listProjects: vi.fn(),
  listRepositoryConnections: vi.fn(),
  listReviews: vi.fn(),
  listRulesets: vi.fn(),
  listSessions: vi.fn(),
  listTokens: vi.fn(),
  login: vi.fn(),
  logoutAllSessions: vi.fn(),
  logoutOtherSessions: vi.fn(),
  publishRuleset: vi.fn(),
  register: vi.fn(),
  resendVerification: vi.fn(),
  resendAdministratorInvitation: vi.fn(),
  revokeAdministratorInvitation: vi.fn(),
  revokePlatformUserSessions: vi.fn(),
  revokeSession: vi.fn(),
  setDefaultRulesetVersion: vi.fn(),
  setPlatformUserRole: vi.fn(),
  setPlatformUserStatus: vi.fn(),
  switchOrganization: vi.fn(),
  triggerReview: vi.fn(),
  updateRulesetDraft: vi.fn(),
  verifyEmail: vi.fn(),
}));

vi.mock('../api/client.js', () => ({ apiClient: mocks }));

import AccountView from './AccountView.vue';
import AdministratorInvitationAcceptView from './AdministratorInvitationAcceptView.vue';
import AdminUsersView from './AdminUsersView.vue';
import InvitationAcceptView from './InvitationAcceptView.vue';
import LoginView from './LoginView.vue';
import ProjectView from './ProjectView.vue';
import ProjectsView from './ProjectsView.vue';
import RegisterView from './RegisterView.vue';
import ReviewDetailView from './ReviewDetailView.vue';
import VerifyEmailView from './VerifyEmailView.vue';

async function mountAt(
  component: Component,
  path: string,
): Promise<{ router: Router; wrapper: VueWrapper }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { component, path: '/login' },
      { component, path: '/register' },
      { component, path: '/verify-email' },
      { component, path: '/account' },
      { component, path: '/admin/users' },
      { component, path: '/administrator-invitations/accept' },
      { component, path: '/invitations/accept' },
      { component, path: '/projects' },
      { component, path: '/projects/:projectId' },
      { component, path: '/reviews/:runId' },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [router] } });
  await flushPromises();
  return { router, wrapper };
}

describe('M1 management views', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptAdministratorInvitation.mockResolvedValue(undefined);
    mocks.acceptInvitation.mockResolvedValue(undefined);
    mocks.changePassword.mockResolvedValue({ revokedFamilies: 1 });
    mocks.createAdministratorInvitation.mockResolvedValue({
      duplicate: false,
      invitation: { id: 'administrator-invitation', status: 'PENDING' },
    });
    mocks.createProject.mockResolvedValue({ id: 'project' });
    mocks.createRepositoryConnection.mockResolvedValue(undefined);
    mocks.createRuleset.mockResolvedValue({ rulesetId: 'ruleset', versionId: 'version' });
    mocks.createRulesetVersion.mockResolvedValue({ version: 2, versionId: 'version-draft' });
    mocks.createToken.mockResolvedValue({ token: 'one-time-token' });
    mocks.disconnectRepositoryConnection.mockResolvedValue(undefined);
    mocks.getGitHubInstallUrl.mockResolvedValue('https://github.test/install');
    mocks.getCurrentActor.mockResolvedValue({
      organizationId: 'organization',
      sessionId: 'session',
      type: 'USER_SESSION',
      userId: 'super',
    });
    mocks.getPlatformUser.mockImplementation((targetUserId: string) =>
      Promise.resolve({
        createdAt: '2026-01-01T00:00:00.000Z',
        email: targetUserId === 'super' ? 'super@example.com' : 'user@example.com',
        id: targetUserId,
        memberships: [{ organizationName: 'Personal', role: 'OWNER' }],
        platformRole: targetUserId === 'super' ? 'SUPER_ADMIN' : 'USER',
        sessions: [{ familyId: 'family' }],
        status: 'ACTIVE',
        tokens: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    mocks.getReview.mockResolvedValue({
      coverage_complete: true,
      head_sha: 'head',
      status: 'SUCCEEDED',
    });
    mocks.listArtifacts.mockResolvedValue([
      { artifactType: 'summary.txt', contentHash: 'hash', id: 'artifact' },
    ]);
    mocks.listAdministratorInvitations.mockResolvedValue({
      invitations: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'super',
          delivery: { status: 'SENT' },
          email: 'invited@example.com',
          expiresAt: '2026-01-02T00:00:00.000Z',
          id: 'administrator-invitation',
          status: 'PENDING',
          targetRole: 'ADMIN',
        },
      ],
    });
    mocks.listFindings.mockResolvedValue([
      {
        description: 'description',
        id: 'finding',
        path: 'src/a.ts',
        severity: 'MAJOR',
        start_line: 1,
        title: 'Finding',
        verification_status: 'CONFIRMED',
      },
    ]);
    mocks.listOrganizations.mockResolvedValue([
      { current: true, id: 'organization', name: 'Personal', role: 'OWNER' },
      { current: false, id: 'second', name: 'Second', role: 'MEMBER' },
    ]);
    mocks.listPlatformUsers.mockResolvedValue({
      users: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          email: 'user@example.com',
          id: 'user',
          platformRole: 'USER',
          status: 'ACTIVE',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    mocks.listProjects.mockResolvedValue([
      { id: 'project', name: 'Review', role: 'MAINTAINER', slug: 'review' },
    ]);
    mocks.listRepositoryConnections.mockResolvedValue([
      { id: 'connection', owner: 'owner', repositoryName: 'repo', status: 'ACTIVE' },
    ]);
    mocks.listReviews.mockResolvedValue([
      {
        completedAt: null,
        coverageComplete: false,
        createdAt: 'now',
        headSha: null,
        id: 'run',
        pullRequestNumber: 7,
        status: 'RUNNING',
      },
    ]);
    mocks.listRulesets.mockResolvedValue([
      {
        contentHash: 'published-hash',
        name: 'Baseline',
        rules: [{ id: 'security/no-secret' }],
        rulesetId: 'ruleset',
        status: 'PUBLISHED',
        version: 1,
        versionId: 'version',
      },
      {
        contentHash: 'draft-hash',
        name: 'Draftable',
        rules: [
          {
            appliesTo: { languages: [], paths: ['**/*'] },
            category: 'DEFECT',
            defaultSeverity: 'BLOCKING',
            evidenceRequirement: 'Evidence',
            guidance: 'Guidance',
            id: 'security/draft',
            title: 'Draft rule',
          },
        ],
        rulesetId: 'draft-ruleset',
        status: 'DRAFT',
        version: 1,
        versionId: 'version-draft',
      },
    ]);
    mocks.listSessions.mockResolvedValue([
      {
        active: true,
        current: true,
        familyId: 'family',
        ipAddress: '192.0.2.50',
        sessionId: 'session',
        userAgent: 'Browser',
      },
    ]);
    mocks.listTokens.mockResolvedValue([{ id: 'token' }]);
    mocks.login.mockResolvedValue(undefined);
    mocks.logoutAllSessions.mockResolvedValue({ revokedFamilies: 1 });
    mocks.logoutOtherSessions.mockResolvedValue({ revokedFamilies: 1 });
    mocks.publishRuleset.mockResolvedValue(undefined);
    mocks.register.mockResolvedValue(undefined);
    mocks.resendVerification.mockResolvedValue(undefined);
    mocks.resendAdministratorInvitation.mockResolvedValue({
      id: 'administrator-invitation',
      status: 'PENDING',
    });
    mocks.revokeAdministratorInvitation.mockResolvedValue({
      id: 'administrator-invitation',
      status: 'REVOKED',
    });
    mocks.revokePlatformUserSessions.mockResolvedValue({ revokedFamilies: 1 });
    mocks.revokeSession.mockResolvedValue({ currentSessionRevoked: false });
    mocks.setDefaultRulesetVersion.mockResolvedValue(undefined);
    mocks.setPlatformUserRole.mockResolvedValue({ id: 'user', platformRole: 'ADMIN' });
    mocks.setPlatformUserStatus.mockResolvedValue({ id: 'user', status: 'SUSPENDED' });
    mocks.switchOrganization.mockResolvedValue(undefined);
    mocks.triggerReview.mockResolvedValue({ runId: 'run', status: 'ACCEPTED' });
    mocks.updateRulesetDraft.mockResolvedValue({
      contentHash: 'updated-hash',
      versionId: 'version-draft',
    });
    mocks.verifyEmail.mockResolvedValue({ organizationId: 'organization' });
  });

  it('submits login and invitation acceptance through the real forms', async () => {
    const login = await mountAt(LoginView, '/login');
    const loginInputs = login.wrapper.findAll('input');
    await loginInputs[0]?.setValue('owner@example.com');
    await loginInputs[1]?.setValue('correct horse battery staple');
    await login.wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(mocks.login).toHaveBeenCalledWith('owner@example.com', 'correct horse battery staple');
    expect(login.router.currentRoute.value.path).toBe('/projects');

    const invitation = await mountAt(
      InvitationAcceptView,
      '/invitations/accept?token=invite-token',
    );
    await invitation.wrapper.find('input').setValue('another secure password');
    await invitation.wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(mocks.acceptInvitation).toHaveBeenCalledWith('invite-token', 'another secure password');
    expect(invitation.router.currentRoute.value.path).toBe('/login');
  });

  it('accepts a platform administrator invitation without issuing a browser session implicitly', async () => {
    const acceptance = await mountAt(
      AdministratorInvitationAcceptView,
      '/administrator-invitations/accept?token=administrator-invitation-token',
    );
    await acceptance.wrapper.find('input').setValue('another secure password');
    await acceptance.wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(mocks.acceptAdministratorInvitation).toHaveBeenCalledWith(
      'administrator-invitation-token',
      'another secure password',
    );
    expect(acceptance.router.currentRoute.value.path).toBe('/login');
  });

  it('rejects incomplete administrator invitation links and renders opaque acceptance failures', async () => {
    const missing = await mountAt(
      AdministratorInvitationAcceptView,
      '/administrator-invitations/accept',
    );
    expect(missing.wrapper.text()).toContain('邀请链接不完整');

    const incomplete = await mountAt(
      AdministratorInvitationAcceptView,
      '/administrator-invitations/accept?token=short',
    );
    expect(incomplete.wrapper.text()).toContain('邀请链接不完整');
    expect(incomplete.wrapper.find('form').exists()).toBe(false);

    mocks.acceptAdministratorInvitation.mockRejectedValueOnce('opaque failure');
    const rejected = await mountAt(
      AdministratorInvitationAcceptView,
      '/administrator-invitations/accept?token=administrator-invitation-token',
    );
    await rejected.wrapper.find('input').setValue('another secure password');
    await rejected.wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(rejected.wrapper.find('[role="alert"]').text()).toBe('管理员邀请接受失败');
    expect(rejected.router.currentRoute.value.path).toBe('/administrator-invitations/accept');

    mocks.acceptAdministratorInvitation.mockRejectedValueOnce(new Error('invitation expired'));
    const expired = await mountAt(
      AdministratorInvitationAcceptView,
      '/administrator-invitations/accept?token=administrator-invitation-token',
    );
    await expired.wrapper.find('input').setValue('another secure password');
    await expired.wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(expired.wrapper.find('[role="alert"]').text()).toBe('invitation expired');
  });

  it('loads and creates projects, then renders service errors', async () => {
    const { wrapper } = await mountAt(ProjectsView, '/projects');
    expect(wrapper.text()).toContain('Review');
    const inputs = wrapper.findAll('input');
    await inputs[0]?.setValue('Second');
    await inputs[1]?.setValue('second');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(mocks.createProject).toHaveBeenCalledWith({ name: 'Second', slug: 'second' });
    expect(mocks.listProjects).toHaveBeenCalledTimes(2);

    mocks.listProjects.mockRejectedValueOnce(new Error('projects unavailable'));
    const failed = await mountAt(ProjectsView, '/projects');
    expect(failed.wrapper.text()).toContain('projects unavailable');
  });

  it('executes project token, ruleset, repository, and review actions with live API state', async () => {
    const { router, wrapper } = await mountAt(ProjectView, '/projects/project?installationId=10');
    expect(wrapper.text()).toContain('owner/repo');

    const buttons = wrapper.findAll('button');
    const byText = (text: string): (typeof buttons)[number] | undefined =>
      buttons.find((button) => button.text().includes(text));
    await byText('创建 Action Token')?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('one-time-token');

    const forms = wrapper.findAll('form');
    await forms[0]?.trigger('submit');
    await flushPromises();
    expect(mocks.createRuleset).toHaveBeenCalled();
    expect(mocks.publishRuleset).not.toHaveBeenCalled();
    await byText('载入规则')?.trigger('click');
    await byText('保存草稿')?.trigger('click');
    await flushPromises();
    expect(mocks.updateRulesetDraft).toHaveBeenCalledWith(
      'project',
      'version-draft',
      expect.objectContaining({ rules: expect.any(Array) }),
    );
    await byText('发布版本')?.trigger('click');
    await flushPromises();
    expect(mocks.publishRuleset).toHaveBeenCalledWith('project', 'version-draft');
    await byText('创建下一草稿')?.trigger('click');
    await flushPromises();
    expect(mocks.createRulesetVersion).toHaveBeenCalledWith('project', 'ruleset', {
      rules: [{ id: 'security/no-secret' }],
    });
    await byText('设为默认')?.trigger('click');
    await flushPromises();
    expect(mocks.setDefaultRulesetVersion).toHaveBeenCalledWith('project', 'version');

    const repositoryInputs = forms[1]?.findAll('input') ?? [];
    expect(repositoryInputs[0]?.element).toHaveProperty('value', '10');
    await repositoryInputs[1]?.setValue('20');
    await forms[1]?.trigger('submit');
    await flushPromises();
    expect(mocks.createRepositoryConnection).toHaveBeenCalledWith('project', {
      installationId: '10',
      repositoryId: '20',
    });
    await byText('断开 owner/repo')?.trigger('click');
    await flushPromises();
    expect(mocks.disconnectRepositoryConnection).toHaveBeenCalledWith('project', 'connection');

    await forms[2]?.trigger('submit');
    await flushPromises();
    expect(mocks.triggerReview).toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/reviews/run');
  });

  it('loads Review findings and artifacts, refreshes on SSE, and closes resources on unmount', async () => {
    class FakeEventSource {
      public static latest: FakeEventSource | undefined;
      public readonly listeners = new Map<string, () => void>();
      public onerror: (() => void) | null = null;
      public close = vi.fn();
      public constructor(public readonly url: string) {
        FakeEventSource.latest = this;
      }
      public addEventListener(name: string, listener: () => void): void {
        this.listeners.set(name, listener);
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const { wrapper } = await mountAt(ReviewDetailView, '/reviews/run');
    expect(wrapper.text()).toContain('SUCCEEDED');
    expect(wrapper.text()).toContain('Finding');
    expect(wrapper.find('a').attributes('href')).toBe('/artifacts/artifact');
    expect(FakeEventSource.latest?.url).toBe('/events/run');

    FakeEventSource.latest?.listeners.get('review.completed')?.();
    FakeEventSource.latest?.onerror?.();
    await flushPromises();
    expect(mocks.getReview.mock.calls.length).toBeGreaterThanOrEqual(3);
    wrapper.unmount();
    expect(FakeEventSource.latest?.close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('registers, verifies email, and manages organizations and sessions through live APIs', async () => {
    const registration = await mountAt(RegisterView, '/register');
    const registrationInputs = registration.wrapper.findAll('input');
    await registrationInputs[0]?.setValue('new@example.com');
    await registrationInputs[1]?.setValue('correct horse battery staple');
    await registration.wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(mocks.register).toHaveBeenCalledWith('new@example.com', 'correct horse battery staple');
    expect(registration.wrapper.text()).toContain('可靠投递队列');

    const verification = await mountAt(
      VerifyEmailView,
      '/verify-email?token=verification-token-value',
    );
    expect(mocks.verifyEmail).toHaveBeenCalledWith('verification-token-value');
    expect(verification.wrapper.text()).toContain('个人 Organization 已创建');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const account = await mountAt(AccountView, '/account');
    expect(account.wrapper.text()).toContain('Second');
    const buttons = account.wrapper.findAll('button');
    await buttons.find((button) => button.text() === '切换')?.trigger('click');
    await flushPromises();
    expect(mocks.switchOrganization).toHaveBeenCalledWith('second');
    await buttons.find((button) => button.text() === '撤销')?.trigger('click');
    await flushPromises();
    expect(mocks.revokeSession).toHaveBeenCalledWith('session');
  });

  it('handles registration resend and verification failures without disclosing account state', async () => {
    const registration = await mountAt(RegisterView, '/register');
    const inputs = registration.wrapper.findAll('input');
    await inputs[0]?.setValue('new@example.com');
    await inputs[1]?.setValue('correct horse battery staple');
    await registration.wrapper.find('form').trigger('submit');
    await flushPromises();
    await registration.wrapper
      .findAll('button')
      .find((button) => button.text().includes('重新发送'))
      ?.trigger('click');
    await flushPromises();
    expect(mocks.resendVerification).toHaveBeenCalledWith('new@example.com');

    mocks.register.mockRejectedValueOnce(new Error('registration unavailable'));
    const failedRegistration = await mountAt(RegisterView, '/register');
    const failedInputs = failedRegistration.wrapper.findAll('input');
    await failedInputs[0]?.setValue('other@example.com');
    await failedInputs[1]?.setValue('another secure password');
    await failedRegistration.wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(failedRegistration.wrapper.text()).toContain('registration unavailable');

    const incomplete = await mountAt(VerifyEmailView, '/verify-email?token=short');
    expect(incomplete.wrapper.text()).toContain('验证链接不完整');
    mocks.verifyEmail.mockRejectedValueOnce(new Error('verification expired'));
    const expired = await mountAt(
      VerifyEmailView,
      '/verify-email?token=expired-verification-token',
    );
    expect(expired.wrapper.text()).toContain('verification expired');
  });

  it('supports complete account-session actions and keeps cancelled mutations local', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { router, wrapper } = await mountAt(AccountView, '/account');
    const button = (label: string): DOMWrapper<Element> | undefined =>
      wrapper.findAll('button').find((candidate) => candidate.text() === label);

    await button('撤销')?.trigger('click');
    expect(mocks.revokeSession).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    mocks.revokeSession.mockResolvedValueOnce({ currentSessionRevoked: true });
    await button('撤销')?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/login');

    const second = await mountAt(AccountView, '/account');
    const secondButton = (label: string): DOMWrapper<Element> | undefined =>
      second.wrapper.findAll('button').find((candidate) => candidate.text() === label);
    await secondButton('退出其他设备')?.trigger('click');
    await flushPromises();
    expect(mocks.logoutOtherSessions).toHaveBeenCalledOnce();
    await secondButton('退出全部设备')?.trigger('click');
    await flushPromises();
    expect(mocks.logoutAllSessions).toHaveBeenCalledOnce();
    expect(second.router.currentRoute.value.path).toBe('/login');

    mocks.listOrganizations.mockRejectedValueOnce(new Error('account unavailable'));
    const failed = await mountAt(AccountView, '/account');
    expect(failed.wrapper.text()).toContain('account unavailable');
  });

  it('surfaces organization-switch and session-revocation failures without losing account state', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.switchOrganization.mockRejectedValueOnce(new Error('switch unavailable'));
    const account = await mountAt(AccountView, '/account');
    await account.wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === '切换')
      ?.trigger('click');
    await flushPromises();
    expect(account.wrapper.text()).toContain('switch unavailable');

    mocks.revokeSession.mockRejectedValueOnce('provider disconnected');
    await account.wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === '撤销')
      ?.trigger('click');
    await flushPromises();
    expect(account.wrapper.text()).toContain('Session 撤销失败');
    expect(account.router.currentRoute.value.path).toBe('/account');
  });

  it('changes the account password and returns to login after server-side family revocation', async () => {
    const account = await mountAt(AccountView, '/account');
    const passwordForm = account.wrapper.find('form');
    const inputs = passwordForm.findAll('input');
    await inputs[0]?.setValue('correct horse battery staple');
    await inputs[1]?.setValue('a different secure password');
    await passwordForm.trigger('submit');
    await flushPromises();

    expect(mocks.changePassword).toHaveBeenCalledWith(
      'correct horse battery staple',
      'a different secure password',
    );
    expect(account.router.currentRoute.value.path).toBe('/login');

    mocks.changePassword.mockRejectedValueOnce('credential service unavailable');
    const failed = await mountAt(AccountView, '/account');
    const failedForm = failed.wrapper.find('form');
    const failedInputs = failedForm.findAll('input');
    await failedInputs[0]?.setValue('correct horse battery staple');
    await failedInputs[1]?.setValue('a different secure password');
    await failedForm.trigger('submit');
    await flushPromises();
    expect(failed.wrapper.text()).toContain('密码变更失败');
    expect(failed.router.currentRoute.value.path).toBe('/account');
  });

  it('queries platform users and requires a confirmed reason for risky administration', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { wrapper } = await mountAt(AdminUsersView, '/admin/users');
    expect(wrapper.text()).toContain('user@example.com');
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('user@example.com'))
      ?.trigger('click');
    await flushPromises();
    expect(mocks.getPlatformUser).toHaveBeenCalledWith('user');
    await wrapper.find('input[name="user-management-reason"]').setValue('Support delegation');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '授予 ADMIN')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.setPlatformUserRole).toHaveBeenCalledWith('user', 'ADMIN', 'Support delegation');
  });

  it('filters and paginates platform users, while confirming status and session mutations', async () => {
    mocks.listPlatformUsers.mockResolvedValueOnce({
      nextCursor: 'next-page',
      users: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          email: 'user@example.com',
          id: 'user',
          platformRole: 'USER',
          status: 'ACTIVE',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { wrapper } = await mountAt(AdminUsersView, '/admin/users');
    const form = wrapper.findAll('form').find((candidate) => candidate.text().includes('有界查询'));
    if (form === undefined) throw new Error('USER_QUERY_FORM_REQUIRED');
    await form.find('input[type="email"]').setValue('USER@example.com');
    const selects = form.findAll('select');
    await selects[0]?.setValue('ACTIVE');
    await selects[1]?.setValue('USER');
    await form.trigger('submit');
    await flushPromises();
    expect(mocks.listPlatformUsers).toHaveBeenLastCalledWith({
      email: 'USER@example.com',
      limit: 25,
      platformRole: 'USER',
      status: 'ACTIVE',
    });

    await wrapper
      .findAll('button')
      .find((candidate) => candidate.text().includes('user@example.com'))
      ?.trigger('click');
    await flushPromises();
    await wrapper.find('input[name="user-management-reason"]').setValue('Security response');
    await wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === '停用账户')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.setPlatformUserStatus).toHaveBeenCalledWith(
      'user',
      'SUSPENDED',
      'Security response',
    );
    await wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === '撤销全部 Session')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.revokePlatformUserSessions).toHaveBeenCalledWith('user', 'Security response');

    confirm.mockReturnValue(false);
    await wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === '恢复账户')
      ?.trigger('click');
    expect(mocks.setPlatformUserStatus).toHaveBeenCalledTimes(1);
  });

  it('creates, resends, and revokes administrator invitations only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { wrapper } = await mountAt(AdminUsersView, '/admin/users');
    await wrapper.find('input[name="administrator-email"]').setValue('new-admin@example.com');
    const reason = wrapper.find('input[name="administrator-invitation-reason"]');
    const form = wrapper.find('form:has(input[name="administrator-email"])');
    await reason.setValue('no');
    await form.trigger('submit');
    expect(confirm).not.toHaveBeenCalled();
    await reason.setValue('Add platform operator');
    await form.trigger('submit');
    expect(mocks.createAdministratorInvitation).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await form.trigger('submit');
    await flushPromises();
    expect(mocks.createAdministratorInvitation).toHaveBeenCalledWith(
      'new-admin@example.com',
      'Add platform operator',
    );
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '重发')
      ?.trigger('click');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '撤销')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.resendAdministratorInvitation).toHaveBeenCalledWith(
      'administrator-invitation',
      'Add platform operator',
    );
    expect(mocks.revokeAdministratorInvitation).toHaveBeenCalledWith(
      'administrator-invitation',
      'Add platform operator',
    );
  });

  it('keeps administrator invitations read-only for a platform ADMIN', async () => {
    mocks.getPlatformUser.mockResolvedValueOnce({
      createdAt: '2026-01-01T00:00:00.000Z',
      email: 'operator@example.com',
      id: 'super',
      memberships: [],
      platformRole: 'ADMIN',
      sessions: [],
      status: 'ACTIVE',
      tokens: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { wrapper } = await mountAt(AdminUsersView, '/admin/users');

    expect(wrapper.text()).toContain('仅 SUPER_ADMIN 可以新增、重发或撤销平台管理员邀请');
    expect(wrapper.find('input[name="administrator-email"]').exists()).toBe(false);
    expect(wrapper.findAll('button').some((button) => button.text() === '重发')).toBe(false);
    expect(mocks.listAdministratorInvitations).toHaveBeenCalled();
  });
});
