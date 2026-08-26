<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  state: 'empty' | 'error' | 'loading' | 'unavailable';
  traceId?: string;
}>();
const copy = computed(() => {
  switch (props.state) {
    case 'loading':
      return { code: 'LOADING', message: '正在加载，请稍候。', title: '加载中' };
    case 'empty':
      return { code: 'EMPTY', message: '当前范围内还没有可展示的内容。', title: '暂无内容' };
    case 'unavailable':
      return { code: '503', message: '请稍后重试。', title: '服务暂时不可用' };
    case 'error':
      return { code: 'ERROR', message: '请稍后重试。', title: '发生了未预期的错误' };
  }
});
</script>

<template>
  <div class="notice" :aria-busy="state === 'loading'">
    <p class="eyebrow">{{ copy.code }}</p>
    <h1>{{ copy.title }}</h1>
    <p>{{ copy.message }}</p>
    <p v-if="traceId" class="trace-id">Trace ID: {{ traceId }}</p>
  </div>
</template>
