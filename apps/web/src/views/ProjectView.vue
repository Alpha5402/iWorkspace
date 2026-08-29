<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { apiClient, type ReviewSummary } from '../api/client.js';

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId));
const rulesets = ref<readonly Record<string, unknown>[]>([]);
const connections = ref<readonly Record<string, unknown>[]>([]);
const tokens = ref<readonly Record<string, unknown>[]>([]);
const reviews = ref<readonly ReviewSummary[]>([]);
const oneTimeToken = ref('');
const error = ref('');
const rulesJson = ref(
  JSON.stringify(
    [
      {
        id: 'security/github-token',
        title: 'GitHub token',
        category: 'DEFECT',
        defaultSeverity: 'BLOCKING',
        appliesTo: { paths: ['**/*'], languages: [] },
        guidance: 'Do not commit credentials.',
        evidenceRequirement: 'Credential material must appear on an added line.',
        deterministicHandler: 'security/github-token',
      },
    ],
    null,
    2,
  ),
);
const rulesetName = ref('Baseline');
const installationId = ref('');
const repositoryId = ref('');
const selectedConnection = ref('');
const pullRequestNumber = ref(1);

async function load(): Promise<void> {
  try {
    [rulesets.value, connections.value, tokens.value, reviews.value] = await Promise.all([
      apiClient.listRulesets(projectId.value),
      apiClient.listRepositoryConnections(projectId.value),
      apiClient.listTokens(projectId.value),
      apiClient.listReviews(projectId.value),
    ]);
    const firstConnectionId = connections.value[0]?.id;
    selectedConnection.value ||= typeof firstConnectionId === 'string' ? firstConnectionId : '';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '项目数据加载失败';
  }
}

async function createToken(): Promise<void> {
  const result = await apiClient.createToken(projectId.value, {
    name: 'GitHub Action',
    scopes: ['review:trigger', 'review:read', 'artifact:read'],
  });
  oneTimeToken.value = typeof result.token === 'string' ? result.token : '';
  await load();
}

async function createRuleset(): Promise<void> {
  const result = await apiClient.createRuleset(projectId.value, {
    name: rulesetName.value,
    rules: JSON.parse(rulesJson.value) as unknown,
  });
  await apiClient.publishRuleset(projectId.value, result.versionId);
  await load();
}

async function connectRepository(): Promise<void> {
  await apiClient.createRepositoryConnection(projectId.value, {
    installationId: installationId.value,
    repositoryId: repositoryId.value,
  });
  await load();
}

async function disconnectRepository(connectionId: string): Promise<void> {
  await apiClient.disconnectRepositoryConnection(projectId.value, connectionId);
  await load();
}

async function setDefaultRuleset(versionId: string): Promise<void> {
  await apiClient.setDefaultRulesetVersion(projectId.value, versionId);
  await load();
}

async function installGitHubApp(): Promise<void> {
  window.location.assign(await apiClient.getGitHubInstallUrl(projectId.value));
}

async function triggerReview(): Promise<void> {
  const review = await apiClient.triggerReview(projectId.value, {
    source: {
      type: 'github_pull_request',
      repositoryConnectionId: selectedConnection.value,
      pullRequestNumber: pullRequestNumber.value,
    },
  });
  await router.push(`/reviews/${review.runId}`);
}

onMounted(async () => {
  installationId.value = String(route.query.installationId ?? '');
  await load();
});
</script>

<template>
  <section>
    <p class="eyebrow">Project {{ projectId }}</p>
    <h1>审查控制台</h1>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="two-column">
      <form class="panel form-stack" @submit.prevent="createRuleset">
        <h2>规则集</h2>
        <label>名称<input v-model="rulesetName" /></label>
        <label>规则 JSON<textarea v-model="rulesJson" rows="12" /></label
        ><button>创建并发布</button>
        <small>{{ rulesets.length }} 个版本</small>
        <button
          v-for="ruleset in rulesets"
          :key="String(ruleset.versionId)"
          type="button"
          @click="setDefaultRuleset(String(ruleset.versionId))"
        >
          设为默认：{{ ruleset.name }} v{{ ruleset.version }}
        </button>
      </form>
      <form class="panel form-stack" @submit.prevent="connectRepository">
        <h2>GitHub App 仓库</h2>
        <button type="button" @click="installGitHubApp">安装 / 更新 GitHub App</button>
        <label>Installation ID<input v-model="installationId" required /></label>
        <label>Repository ID<input v-model="repositoryId" required /></label>
        <small>仓库 Owner、名称和权限由 GitHub API 校验，不信任浏览器输入。</small
        ><button>连接</button>
        <button
          v-for="connection in connections.filter((entry) => entry.status === 'ACTIVE')"
          :key="String(connection.id)"
          type="button"
          @click="disconnectRepository(String(connection.id))"
        >
          断开 {{ connection.owner }}/{{ connection.repositoryName }}
        </button>
      </form>
      <div class="panel form-stack">
        <h2>项目 Access Token</h2>
        <button type="button" @click="createToken">创建 Action Token</button>
        <code v-if="oneTimeToken" class="secret-once">{{ oneTimeToken }}</code>
        <small>仅显示一次 · {{ tokens.length }} 个记录</small>
      </div>
      <form class="panel form-stack" @submit.prevent="triggerReview">
        <h2>触发 Review</h2>
        <label
          >仓库<select v-model="selectedConnection" required>
            <option
              v-for="connection in connections"
              :key="String(connection.id)"
              :value="String(connection.id)"
            >
              {{ connection.owner }}/{{ connection.repositoryName }}
            </option>
          </select></label
        >
        <label>PR 编号<input v-model.number="pullRequestNumber" min="1" type="number" /></label
        ><button>开始审查</button>
      </form>
    </div>
    <div class="panel">
      <h2>最近运行</h2>
      <RouterLink
        v-for="review in reviews"
        :key="review.id"
        class="list-row"
        :to="`/reviews/${review.id}`"
      >
        PR #{{ review.pullRequestNumber }} · {{ review.status }}
      </RouterLink>
    </div>
  </section>
</template>
