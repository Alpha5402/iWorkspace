import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    environment: 'node',
    include: ['apps/**/src/**/*.integration.test.ts', 'packages/**/src/**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
