<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { apiClient } from '../api/client.js';

const runId = String(useRoute().params.runId);
const review = ref<Record<string, unknown>>({});
const findings = ref<readonly Record<string, unknown>[]>([]);
const artifacts = ref<readonly Record<string, unknown>[]>([]);
const error = ref('');
let events: EventSource | undefined;
let polling: number | undefined;

async function load(): Promise<void> {
  try {
    [review.value, findings.value, artifacts.value] = await Promise.all([
      apiClient.getReview(runId),
      apiClient.listFindings(runId),
      apiClient.listArtifacts(runId),
    ]);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'Review 加载失败';
  }
}

onMounted(async () => {
  await load();
  events = new EventSource(apiClient.eventUrl(runId), { withCredentials: true });
  events.addEventListener('review.completed', () => void load());
  events.addEventListener('review.source_frozen', () => void load());
  events.onerror = () => void load();
  polling = window.setInterval(() => void load(), 15_000);
});
onBeforeUnmount(() => {
  events?.close();
  if (polling !== undefined) window.clearInterval(polling);
});
</script>

<template>
  <section>
    <p class="eyebrow">Review {{ runId }}</p>
    <h1>{{ review.status ?? '加载中' }}</h1>
    <p>
      Head: <code>{{ review.head_sha ?? '等待冻结' }}</code> · Coverage:
      {{ review.coverage_complete ? '完整' : '部分/待处理' }}
    </p>
    <p v-if="error" class="error-text">{{ error }}</p>
    <div class="panel">
      <h2>Findings</h2>
      <p v-if="findings.length === 0" class="muted">暂无 Finding。</p>
      <article v-for="finding in findings" :key="String(finding.id)" class="finding">
        <strong>{{ finding.severity }} · {{ finding.title }}</strong
        ><span
          >{{ finding.path }}:{{ finding.start_line }} · {{ finding.verification_status }}</span
        >
        <p>{{ finding.description }}</p>
      </article>
    </div>
    <div class="panel">
      <h2>Artifacts</h2>
      <p v-if="artifacts.length === 0" class="muted">产物尚未生成。</p>
      <a
        v-for="artifact in artifacts"
        :key="String(artifact.id)"
        class="list-row"
        :href="apiClient.artifactDownloadUrl(String(artifact.id))"
      >
        {{ artifact.artifactType }} · {{ artifact.contentHash }}
      </a>
    </div>
  </section>
</template>
