<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { apiClient, type OrganizationSummary, type SessionSummary } from '../api/client.js';

const organizations = ref<readonly OrganizationSummary[]>([]);
const sessions = ref<readonly SessionSummary[]>([]);
const error = ref('');
const currentPassword = ref('');
const newPassword = ref('');
const router = useRouter();

async function load(): Promise<void> {
  error.value = '';
  try {
    [organizations.value, sessions.value] = await Promise.all([
      apiClient.listOrganizations(),
      apiClient.listSessions(),
    ]);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '账户数据加载失败';
  }
}

async function switchOrganization(organizationId: string): Promise<void> {
  try {
    await apiClient.switchOrganization(organizationId);
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'Organization 切换失败';
  }
}

async function revoke(session: SessionSummary): Promise<void> {
  if (!window.confirm('确认撤销该设备对应的整个 Session Family？')) return;
  try {
    const result = await apiClient.revokeSession(session.sessionId);
    if (result.currentSessionRevoked) {
      await router.push('/login');
      return;
    }
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'Session 撤销失败';
  }
}

async function logoutOthers(): Promise<void> {
  if (!window.confirm('确认退出当前设备以外的所有设备？')) return;
  try {
    await apiClient.logoutOtherSessions();
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '退出其他设备失败';
  }
}

async function logoutAll(): Promise<void> {
  if (!window.confirm('确认撤销全部登录设备？当前设备也会退出。')) return;
  try {
    await apiClient.logoutAllSessions();
    await router.push('/login');
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '退出全部设备失败';
  }
}

async function changePassword(): Promise<void> {
  error.value = '';
  try {
    await apiClient.changePassword(currentPassword.value, newPassword.value);
    await router.push('/login');
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '密码变更失败';
  }
}

onMounted(load);
</script>

<template>
  <section>
    <p class="eyebrow">Account security</p>
    <h1>组织与登录设备</h1>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="panel">
      <h2>可访问的 Organization</h2>
      <div v-for="organization in organizations" :key="organization.id" class="list-row">
        <span>{{ organization.name }} · {{ organization.role }}</span>
        <strong v-if="organization.current">当前</strong>
        <button v-else type="button" @click="switchOrganization(organization.id)">切换</button>
      </div>
    </div>
    <div class="panel">
      <h2>Session Family</h2>
      <p>Access Token 不作为长期授权事实；撤销后，现有 Access Token 会立即失效。</p>
      <div v-for="session in sessions" :key="session.familyId" class="list-row">
        <span>
          {{ session.userAgent ?? '未知客户端' }} · {{ session.ipAddress ?? '未知地址' }} ·
          {{ session.active ? '活动' : '已失效' }}
        </span>
        <strong v-if="session.current">当前设备</strong>
        <button v-if="session.active" type="button" @click="revoke(session)">撤销</button>
      </div>
      <div class="action-row">
        <button type="button" @click="logoutOthers">退出其他设备</button>
        <button type="button" @click="logoutAll">退出全部设备</button>
      </div>
    </div>
    <form class="panel form-stack" @submit.prevent="changePassword">
      <h2>变更密码</h2>
      <p>密码更新成功后会撤销全部 Session Family，并要求重新登录。</p>
      <label
        >当前密码<input
          v-model="currentPassword"
          autocomplete="current-password"
          minlength="12"
          required
          type="password"
      /></label>
      <label
        >新密码<input
          v-model="newPassword"
          autocomplete="new-password"
          minlength="12"
          required
          type="password"
      /></label>
      <button type="submit">更新密码并退出全部设备</button>
    </form>
  </section>
</template>
