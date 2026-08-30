import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertRunTransition,
  assertExternalEffectTransition,
  assertTaskTransition,
  createFindingFingerprint,
  determineCheckConclusion,
  DomainError,
  externalEffectStatuses,
  type ExternalEffectStatus,
  runStatuses,
  type RunStatus,
  selectCheckAnnotations,
  taskStatuses,
  type TaskStatus,
  type ReviewFinding,
} from './index.js';

describe('DomainError', () => {
  it('preserves a stable code and message', () => {
    const error = new DomainError('INVALID_TRANSITION', 'The transition is not allowed.');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.message).toBe('The transition is not allowed.');
  });
});

describe('run state machine', () => {
  const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
    ACCEPTED: ['QUEUED', 'CANCELLED'],
    QUEUED: ['RUNNING', 'CANCELLED', 'STALE'],
    RUNNING: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'STALE'],
    SUCCEEDED: [],
    PARTIAL: [],
    FAILED: [],
    CANCELLED: [],
    STALE: [],
  };
  const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
    PENDING: ['LEASED', 'CANCELLED'],
    LEASED: ['SUCCEEDED', 'RETRY_WAIT', 'FAILED', 'CANCELLED'],
    RETRY_WAIT: ['LEASED', 'FAILED', 'CANCELLED'],
    SUCCEEDED: [],
    FAILED: [],
    CANCELLED: [],
  };
  const externalEffectTransitions: Readonly<
    Record<ExternalEffectStatus, readonly ExternalEffectStatus[]>
  > = {
    PREPARED: ['IN_FLIGHT', 'FAILED'],
    IN_FLIGHT: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
    UNKNOWN: ['IN_FLIGHT', 'SUCCEEDED', 'FAILED'],
    SUCCEEDED: [],
    FAILED: ['IN_FLIGHT'],
  };

  it('enforces the complete run transition matrix', () => {
    assertTransitionMatrix(runStatuses, runTransitions, assertRunTransition, 'run');
  });

  it('enforces the complete task and external-effect transition matrices', () => {
    assertTransitionMatrix(taskStatuses, taskTransitions, assertTaskTransition, 'task');
    assertTransitionMatrix(
      externalEffectStatuses,
      externalEffectTransitions,
      assertExternalEffectTransition,
      'external effect',
    );
  });
});

function assertTransitionMatrix<TStatus extends string>(
  statuses: readonly TStatus[],
  allowedTransitions: Readonly<Record<TStatus, readonly TStatus[]>>,
  assertTransition: (current: TStatus, next: TStatus) => void,
  subject: string,
): void {
  for (const current of statuses) {
    for (const next of statuses) {
      if (allowedTransitions[current].includes(next)) {
        expect(() => {
          assertTransition(current, next);
        }, `${subject}: ${current} -> ${next}`).not.toThrow();
      } else {
        expect(() => {
          assertTransition(current, next);
        }, `${subject}: ${current} -> ${next}`).toThrow(
          expect.objectContaining({
            code: 'INVALID_STATE_TRANSITION',
            message: `${subject} cannot transition from ${current} to ${next}`,
          }),
        );
      }
    }
  }
}

describe('review quality gate', () => {
  const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
    confidence: 0.9,
    description: 'The write can race.',
    endLine: 12,
    evidence: ['changed line 10'],
    fingerprint: 'f-1',
    path: 'src/service.ts',
    ruleId: 'reliability/race',
    severity: 'BLOCKING',
    startLine: 10,
    title: 'Race condition',
    verificationStatus: 'CONFIRMED',
    ...overrides,
  });

  it('fails only for a confirmed blocking finding', () => {
    expect(
      determineCheckConclusion({
        coverageComplete: true,
        findings: [finding()],
        runStatus: 'SUCCEEDED',
      }),
    ).toBe('failure');
    expect(
      determineCheckConclusion({
        coverageComplete: true,
        findings: [finding({ severity: 'MAJOR' })],
        runStatus: 'SUCCEEDED',
      }),
    ).toBe('success');
    expect(
      determineCheckConclusion({
        coverageComplete: true,
        findings: [finding({ verificationStatus: 'DISPUTED' })],
        runStatus: 'SUCCEEDED',
      }),
    ).toBe('success');
  });

  it('maps cancelled, failed, uncertain blocking, and partial coverage explicitly', () => {
    expect(
      determineCheckConclusion({ coverageComplete: true, findings: [], runStatus: 'CANCELLED' }),
    ).toBe('cancelled');
    expect(
      determineCheckConclusion({ coverageComplete: true, findings: [], runStatus: 'STALE' }),
    ).toBe('cancelled');
    expect(
      determineCheckConclusion({ coverageComplete: true, findings: [], runStatus: 'FAILED' }),
    ).toBe('action_required');
    expect(
      determineCheckConclusion({
        coverageComplete: true,
        findings: [finding({ verificationStatus: 'NEEDS_HUMAN' })],
        runStatus: 'SUCCEEDED',
      }),
    ).toBe('action_required');
    expect(
      determineCheckConclusion({ coverageComplete: false, findings: [], runStatus: 'PARTIAL' }),
    ).toBe('neutral');
    expect(
      determineCheckConclusion({
        coverageComplete: true,
        findings: [finding({ severity: 'MAJOR', verificationStatus: 'NEEDS_HUMAN' })],
        runStatus: 'SUCCEEDED',
      }),
    ).toBe('success');
  });

  it('publishes only confirmed and locatable annotations in stable order', () => {
    const selected = selectCheckAnnotations([
      finding({ fingerprint: 'minor', severity: 'MINOR' }),
      finding({ fingerprint: 'rejected', verificationStatus: 'REJECTED' }),
      finding({ fingerprint: 'blocking' }),
    ]);
    expect(selected.map((candidate) => candidate.fingerprint)).toEqual(['blocking', 'minor']);
  });

  it('respects line validity, confidence ordering, fingerprint ordering, and the API limit', () => {
    const selected = selectCheckAnnotations(
      [
        finding({ confidence: 0.5, fingerprint: 'z-major', severity: 'MAJOR' }),
        finding({ confidence: 0.9, fingerprint: 'a-major', severity: 'MAJOR' }),
        finding({ endLine: 1, fingerprint: 'invalid', startLine: 2 }),
        finding({ endLine: 0, fingerprint: 'zero-line', startLine: 0 }),
        finding({ endLine: 3, fingerprint: 'single-line', startLine: 3 }),
        finding({ fingerprint: 'info', severity: 'INFO' }),
      ],
      3,
    );
    expect(selected.map((candidate) => candidate.fingerprint)).toEqual([
      'single-line',
      'a-major',
      'z-major',
    ]);
  });

  it('normalizes finding fingerprints', () => {
    const first = createFindingFingerprint({
      codeIdentity: 'line-hash',
      message: 'Unsafe   Write',
      path: 'src/a.ts',
      ruleId: 'r1',
    });
    const second = createFindingFingerprint({
      codeIdentity: 'line-hash',
      message: ' unsafe write ',
      path: 'src/a.ts',
      ruleId: 'r1',
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(
      createHash('sha256').update('r1\0src/a.ts\0line-hash\0unsafe write').digest('hex'),
    );
    expect(
      createFindingFingerprint({
        codeIdentity: 'line-hash',
        message: 'unsafewrite',
        path: 'src/a.ts',
        ruleId: 'r1',
      }),
    ).not.toBe(first);
    for (const changed of [
      { codeIdentity: 'other-line', message: 'unsafe write', path: 'src/a.ts', ruleId: 'r1' },
      { codeIdentity: 'line-hash', message: 'different', path: 'src/a.ts', ruleId: 'r1' },
      { codeIdentity: 'line-hash', message: 'unsafe write', path: 'src/b.ts', ruleId: 'r1' },
      { codeIdentity: 'line-hash', message: 'unsafe write', path: 'src/a.ts', ruleId: 'r2' },
    ]) {
      expect(createFindingFingerprint(changed)).not.toBe(first);
    }
  });
});
