// @vitest-environment jsdom

import { createPinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';

import App from './App.vue';
import CapabilityView from './views/CapabilityView.vue';
import HomeView from './views/HomeView.vue';
import NotFoundView from './views/NotFoundView.vue';
import SystemStateView from './views/SystemStateView.vue';

async function mountAt(path: string): Promise<VueWrapper> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { component: HomeView, path: '/' },
      { component: CapabilityView, path: '/capabilities/:capability' },
      {
        component: SystemStateView,
        path: '/system/unavailable',
        props: { state: 'unavailable' },
      },
      { component: NotFoundView, path: '/:pathMatch(.*)*' },
    ],
  });
  await router.push(path);
  await router.isReady();

  return mount(App, {
    global: {
      plugins: [createPinia(), router],
    },
  });
}

describe('M1 Web shell', () => {
  it('shows the honest M1 review status', async () => {
    const wrapper = await mountAt('/');

    expect(wrapper.text()).toContain('M1 Review Harness');
    expect(wrapper.text()).toContain('不展示模拟业务数据');
  });

  it('shows the planned phase for a capability', async () => {
    const wrapper = await mountAt('/capabilities/design');

    expect(wrapper.text()).toContain('501 · FEATURE_NOT_IMPLEMENTED');
    expect(wrapper.text()).toContain('M2');
  });

  it('shows unknown capability and 404 states', async () => {
    expect((await mountAt('/capabilities/unknown')).text()).toContain('未知能力');
    expect((await mountAt('/missing-page')).text()).toContain('页面不存在');
  });

  it('shows a service unavailable state with a safe Trace ID', async () => {
    const wrapper = await mountAt('/system/unavailable?traceId=trace-123');

    expect(wrapper.text()).toContain('服务暂时不可用');
    expect(wrapper.text()).toContain('Trace ID: trace-123');
  });
});
