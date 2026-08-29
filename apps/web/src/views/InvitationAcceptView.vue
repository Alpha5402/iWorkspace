<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { apiClient } from '../api/client.js';

const route = useRoute();
const router = useRouter();
const token = computed(() => String(route.query.token ?? ''));
const password = ref('');
const error = ref('');
const submitting = ref(false);

async function accept(): Promise<void> {
  submitting.value = true;
  error.value = '';
  try {
    await apiClient.acceptInvitation(token.value, password.value);
    await router.push('/login');
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '邀请接受失败';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="panel narrow-panel">
    <p class="eyebrow">One-time invitation</p>
    <h1>接受邀请</h1>
    <p v-if="!token" class="error-text">邀请链接缺少 Token。</p>
    <form v-else class="form-stack" @submit.prevent="accept">
      <label
        >设置密码<input
          v-model="password"
          type="password"
          minlength="12"
          autocomplete="new-password"
          required
      /></label>
      <button :disabled="submitting" type="submit">
        {{ submitting ? '提交中…' : '加入组织' }}
      </button>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </form>
  </section>
</template>
