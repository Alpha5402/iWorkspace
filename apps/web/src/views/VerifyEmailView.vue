<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { apiClient } from '../api/client.js';

const route = useRoute();
const state = ref<'verifying' | 'verified' | 'failed'>('verifying');
const error = ref('');

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : '';
  if (token.length < 20) {
    state.value = 'failed';
    error.value = '验证链接不完整。';
    return;
  }
  try {
    await apiClient.verifyEmail(token);
    state.value = 'verified';
  } catch (reason) {
    state.value = 'failed';
    error.value = reason instanceof Error ? reason.message : '邮箱验证失败';
  }
});
</script>

<template>
  <section class="panel narrow-panel">
    <p class="eyebrow">Email verification</p>
    <h1>邮箱验证</h1>
    <p v-if="state === 'verifying'" role="status">正在验证一次性凭据…</p>
    <p v-else-if="state === 'verified'" role="status">
      验证完成。你的个人 Organization 已创建，可以前往 <RouterLink to="/login">登录</RouterLink>。
    </p>
    <p v-else class="error-text" role="alert">{{ error }}</p>
  </section>
</template>
