import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    conditions: ['development'],
  },
  test: {
    coverage: {
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/dist/**',
        '**/main.ts',
        '**/cli/benchmarkAdminUsers.ts',
        '**/cli/benchmarkReviewAcceptance.ts',
        '**/cli/bootstrapAdmin.ts',
        '**/router.ts',
        '**/vite-env.d.ts',
      ],
      include: ['apps/**/src/**/*.{ts,vue}', 'packages/**/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        'apps/api/src/application/authService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'apps/worker/src/reviewHarness.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/domain/src/**': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/security/src/**': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        branches: 80,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    reporters: ['default'],
  },
});
