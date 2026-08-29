<script setup lang="ts">
import { ref } from 'vue';

import { apiClient } from '../api/client.js';

const email = ref('');
const password = ref('');
const error = ref('');
const accepted = ref(false);
const submitting = ref(false);

async function submit(): Promise<void> {
  submitting.value = true;
  error.value = '';
  try {
    await apiClient.register(email.value, password.value);
    accepted.value = true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '注册请求失败';
  } finally {
    submitting.value = false;
  }
}

async function resend(): Promise<void> {
  error.value = '';
  try {
    await apiClient.resendVerification(email.value);
    accepted.value = true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '验证邮件重发失败';
  }
}
</script>

<template>
  <section class="panel narrow-panel">
    <p class="eyebrow">Public registration</p>
    <h1>创建 iWorkspace 账户</h1>
    <p>验证邮箱后，系统会为你创建独立的个人 Organization。</p>
    <form class="form-stack" @submit.prevent="submit">
      <label>邮箱<input v-model="email" type="email" autocomplete="email" required /></label>
      <label
        >密码<input
          v-model="password"
          type="password"
          autocomplete="new-password"
          minlength="12"
          required
      /></label>
      <button :disabled="submitting" type="submit">
        {{ submitting ? '提交中…' : '注册' }}
      </button>
      <p v-if="accepted" role="status">
        如果该邮箱可注册，验证邮件已经进入可靠投递队列。请检查邮箱。
      </p>
      <button v-if="accepted" type="button" @click="resend">重新发送验证邮件</button>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </form>
  </section>
</template>
