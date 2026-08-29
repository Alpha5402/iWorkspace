import { describe, expect, it } from 'vitest';

import {
  applicableRules,
  buildReviewBatches,
  parseUnifiedDiff,
  runDeterministicReview,
} from './reviewHarness.js';

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 export const safe = true;
+export const token = "ghp_abcdefghijklmnopqrstuvwxyz";
 export const end = true;`;

describe('review harness', () => {
  it('maps added lines to the right side of a unified diff', () => {
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files[0]).toEqual(
      expect.objectContaining({
        additions: [{ content: 'export const token = "ghp_abcdefghijklmnopqrstuvwxyz";', line: 2 }],
        path: 'src/a.ts',
      }),
    );
    expect(parsed.coverageComplete).toBe(true);
  });

  it('batches deterministically and reports only allowlisted deterministic rules', () => {
    const parsed = parseUnifiedDiff(diff);
    const rules = [
      {
        appliesTo: { languages: ['typescript'], paths: ['src/**/*.ts'] },
        category: 'DEFECT' as const,
        defaultSeverity: 'BLOCKING' as const,
        deterministicHandler: 'security/github-token',
        evidenceRequirement: 'A token-shaped value on an added line.',
        guidance: 'Do not commit tokens.',
        id: 'security/github-token',
        title: 'GitHub token',
      },
    ];
    expect(buildReviewBatches(parsed.files)).toHaveLength(1);
    expect(runDeterministicReview(parsed, rules)).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        severity: 'BLOCKING',
        startLine: 2,
        verificationStatus: 'CONFIRMED',
      }),
    ]);
  });

  it('marks binary files as uncovered and ignores deleted targets', () => {
    const parsed = parseUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
--- a/assets/logo.png
+++ b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const removed = true;`);

    expect(parsed.coverageComplete).toBe(false);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.omitted).toEqual([{ path: 'assets/logo.png', reason: 'BINARY' }]);
  });

  it('sorts, excludes binary files, and splits batches at the configured budget', () => {
    const files = [
      { additions: [], binary: false, patch: 'z'.repeat(32), path: 'z.ts' },
      { additions: [], binary: true, patch: 'binary', path: 'ignored.png' },
      { additions: [], binary: false, patch: 'a'.repeat(32), path: 'a.ts' },
    ];

    const batches = buildReviewBatches(files, 11);

    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.files[0]?.path)).toEqual(['a.ts', 'z.ts']);
    expect(buildReviewBatches([], 11)).toEqual([]);
  });

  it('rejects oversized diffs and maps rules only through declared path scopes', () => {
    expect(() => parseUnifiedDiff('x'.repeat(5 * 1024 * 1024 + 1))).toThrow(
      'DIFF_SIZE_LIMIT_EXCEEDED',
    );
    expect(
      applicableRules(
        [
          {
            appliesTo: { languages: [], paths: ['src/**'] },
            category: 'DESIGN',
            defaultSeverity: 'INFO',
            evidenceRequirement: 'Evidence',
            guidance: 'Guidance',
            id: 'scope/src',
            title: 'Source only',
          },
        ],
        'tests/a.ts',
      ),
    ).toEqual([]);
  });
});
