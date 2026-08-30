/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  concurrency: 4,
  mutate: ['packages/domain/src/index.ts', 'packages/security/src/index.ts'],
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: {
    fileName: '.workspace/proofs/mutation-report.json',
  },
  testRunner: 'vitest',
  thresholds: {
    break: 90,
    high: 95,
    low: 90,
  },
  timeoutMS: 60_000,
  vitest: {
    configFile: 'vitest.config.ts',
    related: true,
  },
};

export default config;
