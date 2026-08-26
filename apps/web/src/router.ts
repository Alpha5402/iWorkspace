import { createRouter, createWebHistory, type Router } from 'vue-router';

import CapabilityView from './views/CapabilityView.vue';
import HomeView from './views/HomeView.vue';
import NotFoundView from './views/NotFoundView.vue';
import SystemStateView from './views/SystemStateView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    requiredPermission?: string;
  }
}

export type PermissionCheck = (permission: string) => boolean;

export function installPermissionGuard(
  targetRouter: Router,
  hasPermission: PermissionCheck = () => false,
): void {
  targetRouter.beforeEach((to) => {
    const requiredPermission = to.meta.requiredPermission;
    if (requiredPermission === undefined || hasPermission(requiredPermission)) return true;

    return {
      name: 'capability',
      params: { capability: 'identity' },
      query: { denied: requiredPermission },
    };
  });
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { component: HomeView, name: 'home', path: '/' },
    { component: CapabilityView, name: 'capability', path: '/capabilities/:capability' },
    {
      component: SystemStateView,
      name: 'service-unavailable',
      path: '/system/unavailable',
      props: { state: 'unavailable' },
    },
    {
      component: SystemStateView,
      name: 'unexpected-error',
      path: '/system/error',
      props: { state: 'error' },
    },
    { component: NotFoundView, name: 'not-found', path: '/:pathMatch(.*)*' },
  ],
});

installPermissionGuard(router);
