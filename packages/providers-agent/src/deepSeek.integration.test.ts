import { describe, expect, it } from 'vitest';

import { DeepSeekResponsesProvider } from './index.js';

const runRealProviderTest = process.env.RUN_DEEPSEEK_E2E === 'true';

describe.runIf(runRealProviderTest)('DeepSeek Responses provider', () => {
  it('accepts a schema-validated response from the configured real model', async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('DEEPSEEK_API_KEY_REQUIRED_WHEN_RUN_DEEPSEEK_E2E_IS_TRUE');
    }

    const provider = new DeepSeekResponsesProvider(apiKey);
    const result = await provider.reviewBatch(
      {
        category: 'DEFECT',
        diff: [
          'diff --git a/src/example.ts b/src/example.ts',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -1 +1 @@',
          '-export const retries = 3;',
          '+export const retries = 3;',
        ].join('\n'),
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
        promptVersion: 'review-provider-e2e-v1',
        rules: [
          {
            evidenceRequirement: 'The defect must be visible on an added line.',
            guidance: 'Report only correctness defects supported by the supplied diff.',
            id: 'defect/correctness',
            severity: 'MAJOR',
            title: 'Correctness',
          },
        ],
      },
      AbortSignal.timeout(180_000),
    );

    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.output.summary.length).toBeGreaterThan(0);
    expect(result.output.findings.length).toBeLessThanOrEqual(100);
  }, 180_000);
});
