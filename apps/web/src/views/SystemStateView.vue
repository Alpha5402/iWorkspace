<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import UiStatePanel from '../components/UiStatePanel.vue';

const { state } = defineProps<{ state: 'error' | 'unavailable' }>();
const route = useRoute();
const traceId = computed(() => {
  const value = route.query.traceId;
  return typeof value === 'string' && value.length <= 128 ? value : undefined;
});
const panelProps = computed(() =>
  traceId.value === undefined ? { state } : { state, traceId: traceId.value },
);
</script>

<template>
  <section>
    <UiStatePanel v-bind="panelProps" />
    <p>若问题持续，请将 Trace ID 提供给维护者。</p>
    <RouterLink to="/">返回工程概览</RouterLink>
  </section>
</template>
