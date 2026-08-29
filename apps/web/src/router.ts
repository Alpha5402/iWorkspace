import { createRouter, createWebHistory, type Router } from 'vue-router';

import CapabilityView from './views/CapabilityView.vue';
import AccountView from './views/AccountView.vue';
import AdminUsersView from './views/AdminUsersView.vue';
import HomeView from './views/HomeView.vue';
import InvitationAcceptView from './views/InvitationAcceptView.vue';
import LoginView from './views/LoginView.vue';
import NotFoundView from './views/NotFoundView.vue';
import SystemStateView from './views/SystemStateView.vue';
import ProjectsView from './views/ProjectsView.vue';
import ProjectView from './views/ProjectView.vue';
import RegisterView from './views/RegisterView.vue';
import ReviewDetailView from './views/ReviewDetailView.vue';
import VerifyEmailView from './views/VerifyEmailView.vue';

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
    { component: LoginView, name: 'login', path: '/login' },
    { component: RegisterView, name: 'register', path: '/register' },
    { component: VerifyEmailView, name: 'verify-email', path: '/verify-email' },
    { component: AccountView, name: 'account', path: '/account' },
    { component: AdminUsersView, name: 'admin-users', path: '/admin/users' },
    { component: InvitationAcceptView, name: 'invitation-accept', path: '/invitations/accept' },
    { component: ProjectsView, name: 'projects', path: '/projects' },
    { component: ProjectView, name: 'project', path: '/projects/:projectId' },
    { component: ReviewDetailView, name: 'review', path: '/reviews/:runId' },
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
