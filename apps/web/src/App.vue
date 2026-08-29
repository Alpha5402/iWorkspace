<script setup lang="ts">
import { capabilities } from '@delivery/contracts';
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <RouterLink class="brand" to="/">AI Delivery Control Plane</RouterLink>
      <span class="phase-badge">M1 Review Harness</span>
    </header>
    <aside class="sidebar" aria-label="能力导航">
      <RouterLink to="/login">登录</RouterLink>
      <RouterLink to="/register">注册</RouterLink>
      <RouterLink to="/account">组织与设备</RouterLink>
      <RouterLink to="/admin/users">用户管理</RouterLink>
      <RouterLink to="/projects">项目与审查</RouterLink>
      <RouterLink
        v-for="capability in capabilities.filter((entry) => entry.plannedPhase !== 'M1')"
        :key="capability.id"
        :to="`/capabilities/${capability.id}`"
      >
        {{ capability.id }} · {{ capability.plannedPhase }}
      </RouterLink>
    </aside>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>
