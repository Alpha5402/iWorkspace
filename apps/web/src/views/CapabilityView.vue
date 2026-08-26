<script setup lang="ts">
import { capabilities } from '@delivery/contracts';
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const capability = computed(() =>
  capabilities.find((candidate) => candidate.id === route.params.capability),
);
</script>

<template>
  <section v-if="capability">
    <p class="eyebrow">{{ capability.plannedPhase }}</p>
    <h1>{{ capability.id }}</h1>
    <div class="notice">
      <strong>501 · FEATURE_NOT_IMPLEMENTED</strong>
      <p>此能力已预留稳定边界，将在 {{ capability.plannedPhase }} 实现。</p>
    </div>
  </section>
  <section v-else>
    <h1>未知能力</h1>
    <p>能力注册表中不存在该标识。</p>
  </section>
</template>
