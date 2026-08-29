<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { apiClient, type PlatformUserDetail, type PlatformUserSummary } from '../api/client.js';

const users = ref<readonly PlatformUserSummary[]>([]);
const selected = ref<PlatformUserDetail>();
const nextCursor = ref<string>();
const email = ref('');
const platformRole = ref<'' | PlatformUserSummary['platformRole']>('');
const status = ref<'' | PlatformUserSummary['status']>('');
const reason = ref('');
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

onMounted(() => load());
</script>

<template>
  <section>
    <p class="eyebrow">Platform administration</p>
    <h1>全站用户管理</h1>
    <p>平台角色不继承任何租户项目权限；进入项目仍需显式 Membership。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
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
        <label>操作原因<input v-model="reason" minlength="3" required /></label>
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
