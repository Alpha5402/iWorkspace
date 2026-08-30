<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { apiClient } from '../api/client.js';

const route = useRoute();
const router = useRouter();
const token = typeof route.query.token === 'string' ? route.query.token : '';
const password = ref('');
const error = ref('');
const submitting = ref(false);

async function submit(): Promise<void> {
  if (token.length < 20) return;
  error.value = '';
  submitting.value = true;
  try {
    await apiClient.acceptAdministratorInvitation(token, password.value);
    await router.push('/login?administratorInvitation=accepted');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '管理员邀请接受失败';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="narrow-page">
    <p class="eyebrow">Platform administrator invitation</p>
    <h1>激活管理员账户</h1>
    <p>请由受邀者本人设置密码。后台管理员无法查看或代设该密码。</p>
    <p v-if="token.length < 20" class="error-text" role="alert">邀请链接不完整。</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <form v-if="token.length >= 20" class="panel form-stack" @submit.prevent="submit">
      <label>
        密码
        <input
          v-model="password"
          type="password"
          minlength="12"
          autocomplete="new-password"
          required
        />
      </label>
      <button :disabled="submitting">{{ submitting ? '激活中…' : '验证邮箱并激活' }}</button>
    </form>
  </section>
</template>
