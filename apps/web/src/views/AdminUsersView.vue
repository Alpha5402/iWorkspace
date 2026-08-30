<script setup lang="ts">
import { onMounted, ref } from 'vue';

import {
  apiClient,
  type AdministratorInvitationSummary,
  type PlatformUserDetail,
  type PlatformUserSummary,
} from '../api/client.js';

const users = ref<readonly PlatformUserSummary[]>([]);
const selected = ref<PlatformUserDetail>();
const nextCursor = ref<string>();
const email = ref('');
const platformRole = ref<'' | PlatformUserSummary['platformRole']>('');
const status = ref<'' | PlatformUserSummary['status']>('');
const reason = ref('');
const invitations = ref<readonly AdministratorInvitationSummary[]>([]);
const invitationEmail = ref('');
const invitationReason = ref('');
const invitationStatus = ref<'' | AdministratorInvitationSummary['status']>('');
const nextInvitationCursor = ref<string>();
const currentPlatformRole = ref<PlatformUserSummary['platformRole']>();
const error = ref('');

async function load(cursor?: string): Promise<void> {
  error.value = '';
  try {
    const page = await apiClient.listPlatformUsers({
      ...(cursor === undefined ? {} : { cursor }),
      ...(email.value === '' ? {} : { email: email.value }),
      limit: 25,
      ...(platformRole.value === '' ? {} : { platformRole: platformRole.value }),
      ...(status.value === '' ? {} : { status: status.value }),
    });
    users.value = cursor === undefined ? page.users : [...users.value, ...page.users];
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '用户列表加载失败';
  }
}

async function loadCurrentRole(): Promise<void> {
  try {
    const actor = await apiClient.getCurrentActor();
    currentPlatformRole.value = (await apiClient.getPlatformUser(actor.userId)).platformRole;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '当前管理员身份加载失败';
  }
}

async function loadInvitations(cursor?: string): Promise<void> {
  try {
    const page = await apiClient.listAdministratorInvitations({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 25,
      ...(invitationStatus.value === '' ? {} : { status: invitationStatus.value }),
    });
    invitations.value =
      cursor === undefined ? page.invitations : [...invitations.value, ...page.invitations];
    nextInvitationCursor.value = page.nextCursor;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '管理员邀请加载失败';
  }
}

async function createAdministratorInvitation(): Promise<void> {
  if (invitationReason.value.trim().length < 3) return;
  if (!window.confirm(`确认邀请 ${invitationEmail.value} 成为平台 ADMIN？`)) return;
  error.value = '';
  try {
    await apiClient.createAdministratorInvitation(
      invitationEmail.value,
      invitationReason.value.trim(),
    );
    invitationEmail.value = '';
    await loadInvitations();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '管理员邀请创建失败';
  }
}

async function resendInvitation(invitation: AdministratorInvitationSummary): Promise<void> {
  if (invitationReason.value.trim().length < 3) return;
  if (!window.confirm(`确认重发 ${invitation.email} 的邀请并使旧链接失效？`)) return;
  try {
    await apiClient.resendAdministratorInvitation(invitation.id, invitationReason.value.trim());
    await loadInvitations();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '管理员邀请重发失败';
  }
}

async function revokeInvitation(invitation: AdministratorInvitationSummary): Promise<void> {
  if (invitationReason.value.trim().length < 3) return;
  if (!window.confirm(`确认撤销 ${invitation.email} 的管理员邀请？`)) return;
  try {
    await apiClient.revokeAdministratorInvitation(invitation.id, invitationReason.value.trim());
    await loadInvitations();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '管理员邀请撤销失败';
  }
}

async function selectUser(userId: string): Promise<void> {
  error.value = '';
  try {
    selected.value = await apiClient.getPlatformUser(userId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '用户详情加载失败';
  }
}

async function changeStatus(statusValue: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
  if (selected.value === undefined || reason.value.trim().length < 3) return;
  if (!window.confirm(`确认将 ${selected.value.email} 的状态改为 ${statusValue}？`)) return;
  try {
    await apiClient.setPlatformUserStatus(selected.value.id, statusValue, reason.value.trim());
    await refreshSelection();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '状态更新失败';
  }
}

async function changeRole(role: 'ADMIN' | 'USER'): Promise<void> {
  if (selected.value === undefined || reason.value.trim().length < 3) return;
  if (!window.confirm(`确认将 ${selected.value.email} 的平台角色改为 ${role}？`)) return;
  try {
    await apiClient.setPlatformUserRole(selected.value.id, role, reason.value.trim());
    await refreshSelection();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '角色更新失败';
  }
}

async function revokeSessions(): Promise<void> {
  if (selected.value === undefined || reason.value.trim().length < 3) return;
  if (!window.confirm(`确认撤销 ${selected.value.email} 的全部 Session Family？`)) return;
  try {
    await apiClient.revokePlatformUserSessions(selected.value.id, reason.value.trim());
    await refreshSelection();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Session 撤销失败';
  }
}

async function refreshSelection(): Promise<void> {
  const userId = selected.value?.id;
  await load();
  if (userId !== undefined) await selectUser(userId);
}

onMounted(() => Promise.all([load(), loadCurrentRole(), loadInvitations()]));
</script>

<template>
  <section>
    <p class="eyebrow">Platform administration</p>
    <h1>全站用户管理</h1>
    <p>平台角色不继承任何租户项目权限；进入项目仍需显式 Membership。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div class="panel form-stack">
      <h2>管理员邀请</h2>
      <p v-if="currentPlatformRole !== 'SUPER_ADMIN'">
        仅 SUPER_ADMIN 可以新增、重发或撤销平台管理员邀请。
      </p>
      <form
        v-if="currentPlatformRole === 'SUPER_ADMIN'"
        class="form-stack"
        @submit.prevent="createAdministratorInvitation"
      >
        <label
          >受邀邮箱<input
            v-model="invitationEmail"
            name="administrator-email"
            type="email"
            required
        /></label>
        <label
          >操作原因<input
            v-model="invitationReason"
            name="administrator-invitation-reason"
            minlength="3"
            maxlength="500"
            required
        /></label>
        <button>新增管理员</button>
      </form>
      <label
        >邀请状态<select v-model="invitationStatus" @change="loadInvitations()">
          <option value="">全部</option>
          <option value="PENDING">待接受</option>
          <option value="ACCEPTED">已接受</option>
          <option value="REVOKED">已撤销</option>
          <option value="EXPIRED">已过期</option>
        </select></label
      >
      <div v-for="invitation in invitations" :key="invitation.id" class="list-row">
        <span>
          {{ invitation.email }} · {{ invitation.status }} · 邮件 {{ invitation.delivery.status }} ·
          到期 {{ new Date(invitation.expiresAt).toLocaleString() }}
        </span>
        <div v-if="currentPlatformRole === 'SUPER_ADMIN'" class="action-row">
          <button
            v-if="invitation.status === 'PENDING' || invitation.status === 'EXPIRED'"
            type="button"
            @click="resendInvitation(invitation)"
          >
            重发
          </button>
          <button
            v-if="invitation.status === 'PENDING' || invitation.status === 'EXPIRED'"
            type="button"
            @click="revokeInvitation(invitation)"
          >
            撤销
          </button>
        </div>
      </div>
      <button
        v-if="nextInvitationCursor"
        type="button"
        @click="loadInvitations(nextInvitationCursor)"
      >
        加载更多邀请
      </button>
    </div>

    <form class="panel form-stack" @submit.prevent="load()">
      <h2>有界查询</h2>
      <label>精确邮箱<input v-model="email" type="email" /></label>
      <label
        >账户状态<select v-model="status">
          <option value="">全部</option>
          <option value="PENDING_VERIFICATION">待验证</option>
          <option value="ACTIVE">活动</option>
          <option value="SUSPENDED">已停用</option>
        </select></label
      >
      <label
        >平台角色<select v-model="platformRole">
          <option value="">全部</option>
          <option value="SUPER_ADMIN">超级管理员</option>
          <option value="ADMIN">管理员</option>
          <option value="USER">普通用户</option>
        </select></label
      >
      <button>查询</button>
    </form>
    <div class="two-column">
      <div class="panel">
        <h2>用户</h2>
        <button
          v-for="user in users"
          :key="user.id"
          class="list-row"
          type="button"
          @click="selectUser(user.id)"
        >
          {{ user.email }} · {{ user.platformRole }} · {{ user.status }}
        </button>
        <button v-if="nextCursor" type="button" @click="load(nextCursor)">加载下一页</button>
      </div>
      <div v-if="selected" class="panel form-stack">
        <h2>{{ selected.email }}</h2>
        <p>平台角色：{{ selected.platformRole }} · 状态：{{ selected.status }}</p>
        <p>
          租户 Membership：
          {{
            selected.memberships
              .map((membership) => `${membership.organizationName} (${membership.role})`)
              .join('、') || '无'
          }}
        </p>
        <p>Session Family：{{ selected.sessions.length }}</p>
        <p>创建的项目 Token：{{ selected.tokens.length }}</p>
        <div v-for="token in selected.tokens" :key="token.id" class="list-row">
          <span>
            {{ token.projectName }} · {{ token.name }} · {{ token.tokenPrefix }}… ·
            {{ token.revokedAt ? '已撤销' : '有效或待过期检查' }}
          </span>
        </div>
        <label
          >操作原因<input v-model="reason" name="user-management-reason" minlength="3" required
        /></label>
        <div class="action-row">
          <button type="button" @click="changeStatus('SUSPENDED')">停用账户</button>
          <button type="button" @click="changeStatus('ACTIVE')">恢复账户</button>
          <button type="button" @click="changeRole('ADMIN')">授予 ADMIN</button>
          <button type="button" @click="changeRole('USER')">撤销 ADMIN</button>
          <button type="button" @click="revokeSessions">撤销全部 Session</button>
        </div>
      </div>
    </div>
  </section>
</template>
