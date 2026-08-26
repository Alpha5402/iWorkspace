// @vitest-environment jsdom

import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';

import { installPermissionGuard } from './router.js';

const EmptyView = defineComponent({ template: '<div />' });

describe('permission guard', () => {
  it('redirects a denied permission to the honest identity placeholder', async () => {
    const testRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        { component: EmptyView, name: 'capability', path: '/capabilities/:capability' },
        {
          component: EmptyView,
          meta: { requiredPermission: 'project:read' },
          path: '/protected',
        },
      ],
    });
    installPermissionGuard(testRouter, () => false);

    await testRouter.push('/protected');

    expect(testRouter.currentRoute.value.fullPath).toBe(
      '/capabilities/identity?denied=project:read',
    );
  });
});
