// @vitest-environment jsdom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Component } from 'vue';

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  artifactDownloadUrl: vi.fn((id: string) => `/artifacts/${id}`),
  createProject: vi.fn(),
  createRepositoryConnection: vi.fn(),
  createRuleset: vi.fn(),
  createToken: vi.fn(),
  disconnectRepositoryConnection: vi.fn(),
  eventUrl: vi.fn((id: string) => `/events/${id}`),
  getGitHubInstallUrl: vi.fn(),
  getReview: vi.fn(),
  listArtifacts: vi.fn(),
  listFindings: vi.fn(),
  listProjects: vi.fn(),
  listRepositoryConnections: vi.fn(),
  listReviews: vi.fn(),
  listRulesets: vi.fn(),
  listTokens: vi.fn(),
  login: vi.fn(),
  publishRuleset: vi.fn(),
  setDefaultRulesetVersion: vi.fn(),
  triggerReview: vi.fn(),
}));

vi.mock('../api/client.js', () => ({ apiClient: mocks }));

import InvitationAcceptView from './InvitationAcceptView.vue';
import LoginView from './LoginView.vue';
import ProjectView from './ProjectView.vue';
import ProjectsView from './ProjectsView.vue';
import ReviewDetailView from './ReviewDetailView.vue';

async function mountAt(
  component: Component,
  path: string,
): Promise<{ router: Router; wrapper: VueWrapper }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { component, path: '/login' },
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptInvitation.mockResolvedValue(undefined);
    mocks.createProject.mockResolvedValue({ id: 'project' });
    mocks.createRepositoryConnection.mockResolvedValue(undefined);
    mocks.createRuleset.mockResolvedValue({ rulesetId: 'ruleset', versionId: 'version' });
    mocks.createToken.mockResolvedValue({ token: 'one-time-token' });
    mocks.disconnectRepositoryConnection.mockResolvedValue(undefined);
    mocks.getGitHubInstallUrl.mockResolvedValue('https://github.test/install');
    mocks.getReview.mockResolvedValue({
      coverage_complete: true,
      head_sha: 'head',
      status: 'SUCCEEDED',
    });
    mocks.listArtifacts.mockResolvedValue([
      { artifactType: 'summary.txt', contentHash: 'hash', id: 'artifact' },
    ]);
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
      { name: 'Baseline', version: 1, versionId: 'version', status: 'PUBLISHED' },
    ]);
    mocks.listTokens.mockResolvedValue([{ id: 'token' }]);
    mocks.login.mockResolvedValue(undefined);
    mocks.publishRuleset.mockResolvedValue(undefined);
    mocks.setDefaultRulesetVersion.mockResolvedValue(undefined);
    mocks.triggerReview.mockResolvedValue({ runId: 'run', status: 'ACCEPTED' });
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
    expect(mocks.publishRuleset).toHaveBeenCalledWith('project', 'version');
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
});
