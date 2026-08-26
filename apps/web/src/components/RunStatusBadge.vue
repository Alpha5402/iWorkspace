<script setup lang="ts">
import { type RunStatus } from '@delivery/contracts';
import { computed } from 'vue';

import { runStatusPresentation } from '../presentation/runStatus.js';

const props = defineProps<{ status: RunStatus }>();
const presentation = computed(() => runStatusPresentation[props.status]);
</script>

<template>
  <span class="phase-badge" :data-tone="presentation.tone">{{ presentation.label }}</span>
</template>
