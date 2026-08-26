<script setup lang="ts">
import { capabilities } from '@delivery/contracts';
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <RouterLink class="brand" to="/">AI Delivery Control Plane</RouterLink>
      <span class="phase-badge">M0 Framework</span>
    </header>
    <aside class="sidebar" aria-label="能力导航">
      <RouterLink
        v-for="capability in capabilities"
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
