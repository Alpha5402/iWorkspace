<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { apiClient } from '../api/client.js';

const email = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);
const router = useRouter();

async function submit(): Promise<void> {
  submitting.value = true;
  error.value = '';
  try {
    await apiClient.login(email.value, password.value);
    await router.push('/projects');
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '登录失败';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="panel narrow-panel">
    <p class="eyebrow">JWT access + refresh session</p>
    <h1>登录 iWorkspace</h1>
    <form class="form-stack" @submit.prevent="submit">
      <label>邮箱<input v-model="email" type="email" autocomplete="username" required /></label>
      <label
        >密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          minlength="12"
          required
      /></label>
      <button :disabled="submitting" type="submit">{{ submitting ? '登录中…' : '登录' }}</button>
      <RouterLink to="/register">没有账户？公开注册</RouterLink>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </form>
  </section>
</template>
