import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';

import { type RuleDefinition } from '@delivery/contracts';
import { createFindingFingerprint, type ReviewFinding } from '@delivery/domain';

type DiffLine = Readonly<{ content: string; line: number }>;
export type DiffFile = Readonly<{
  additions: readonly DiffLine[];
  binary: boolean;
  patch: string;
  path: string;
}>;
export type ParsedDiff = Readonly<{
  contentHash: string;
  coverageComplete: boolean;
  files: readonly DiffFile[];
  omitted: readonly Readonly<{ path: string; reason: string }>[];
}>;

const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 2_000;

export function parseUnifiedDiff(diff: string): ParsedDiff {
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw new Error('DIFF_SIZE_LIMIT_EXCEEDED');
  const files: DiffFile[] = [];
  let currentPath: string | undefined;
  let currentPatch: string[] = [];
  let additions: DiffLine[] = [];
  let currentNewLine = 0;
  let binary = false;

  const flush = (): void => {
    if (currentPath === undefined) return;
    files.push({ additions, binary, patch: currentPatch.join('\n'), path: currentPath });
    currentPath = undefined;
    currentPatch = [];
    additions = [];
    binary = false;
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPatch.push(line);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      currentPath = target === '/dev/null' ? undefined : target.replace(/^b\//, '');
      currentPatch.push(line);
      continue;
    }
    if (currentPath === undefined) continue;
    currentPatch.push(line);
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.[1] !== undefined) {
      currentNewLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions.push({ content: line.slice(1), line: currentNewLine });
      currentNewLine += 1;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      currentNewLine += 1;
    }
  }
  flush();
  const included = files.slice(0, MAX_FILES);
  const omitted = files.slice(MAX_FILES).map((file) => ({ path: file.path, reason: 'FILE_LIMIT' }));
  return {
    contentHash: createHash('sha256').update(diff).digest('hex'),
    coverageComplete: omitted.length === 0 && included.every((file) => !file.binary),
    files: included,
    omitted: [
      ...omitted,
      ...included
        .filter((file) => file.binary)
        .map((file) => ({ path: file.path, reason: 'BINARY' })),
    ],
  };
}

export function applicableRules(
  rules: readonly RuleDefinition[],
  path: string,
): readonly RuleDefinition[] {
  return rules.filter((rule) => rule.appliesTo.paths.some((pattern) => matchesGlob(path, pattern)));
}

export type ReviewBatch = Readonly<{
  estimatedTokens: number;
  files: readonly DiffFile[];
  inputHash: string;
  sequence: number;
}>;

export function buildReviewBatches(
  files: readonly DiffFile[],
  maxEstimatedTokens = 20_000,
): readonly ReviewBatch[] {
  const sorted = files
    .filter((file) => !file.binary)
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const batches: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let currentTokens = 0;
  for (const file of sorted) {
    const estimated = Math.ceil(Buffer.byteLength(file.patch) / 3.2);
    if (current.length > 0 && currentTokens + estimated > maxEstimatedTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(file);
    currentTokens += estimated;
  }
  if (current.length > 0) batches.push(current);
  return batches.map((batchFiles, sequence) => {
    const input = batchFiles.map((file) => file.patch).join('\n');
    return {
      estimatedTokens: Math.ceil(Buffer.byteLength(input) / 3.2),
      files: batchFiles,
      inputHash: createHash('sha256').update(input).digest('hex'),
      sequence,
    };
  });
}

const deterministicPatterns = [
  { id: 'security/private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'security/github-token', pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { id: 'security/aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
] as const;

export function runDeterministicReview(
  parsedDiff: ParsedDiff,
  rules: readonly RuleDefinition[],
): readonly ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const file of parsedDiff.files) {
    const mappedRuleIds = new Set(applicableRules(rules, file.path).map((rule) => rule.id));
    for (const addition of file.additions) {
      for (const detector of deterministicPatterns) {
        if (!mappedRuleIds.has(detector.id) || !detector.pattern.test(addition.content)) continue;
        const description = 'A credential-like value was added to source control.';
        findings.push({
          confidence: 0.99,
          description,
          endLine: addition.line,
          evidence: [
            `added-line:${addition.line}`,
            `content-sha256:${createHash('sha256').update(addition.content).digest('hex')}`,
          ],
          fingerprint: createFindingFingerprint({
            codeIdentity: createHash('sha256').update(addition.content).digest('hex'),
            message: description,
            path: file.path,
            ruleId: detector.id,
          }),
          path: file.path,
          ruleId: detector.id,
          severity: 'BLOCKING',
          startLine: addition.line,
          title: 'Credential material in diff',
          verificationStatus: 'CONFIRMED',
        });
      }
    }
  }
  return findings;
}
