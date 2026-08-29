<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { apiClient, type ProjectSummary } from '../api/client.js';

const projects = ref<readonly ProjectSummary[]>([]);
const name = ref('');
const slug = ref('');
const error = ref('');

async function load(): Promise<void> {
  try {
    projects.value = await apiClient.listProjects();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '项目加载失败';
  }
}

async function create(): Promise<void> {
  try {
    await apiClient.createProject({ name: name.value, slug: slug.value });
    name.value = '';
    slug.value = '';
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '项目创建失败';
  }
}

onMounted(load);
</script>

<template>
  <section>
    <p class="eyebrow">M1 Control Plane</p>
    <h1>项目</h1>
    <div class="grid-list">
      <RouterLink
        v-for="project in projects"
        :key="project.id"
        class="card"
        :to="`/projects/${project.id}`"
      >
        <strong>{{ project.name }}</strong
        ><span>{{ project.slug }} · {{ project.role }}</span>
      </RouterLink>
      <p v-if="projects.length === 0" class="muted">还没有项目。</p>
    </div>
    <form class="panel form-stack" @submit.prevent="create">
      <h2>创建项目</h2>
      <label>名称<input v-model="name" required /></label>
      <label>Slug<input v-model="slug" pattern="[a-z0-9][a-z0-9-]{0,62}" required /></label>
      <button type="submit">创建</button>
    </form>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </section>
</template>
