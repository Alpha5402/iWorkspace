import { describe, expect, it } from 'vitest';

import {
  assertRunTransition,
  assertExternalEffectTransition,
  assertTaskTransition,
  createFindingFingerprint,
  determineCheckConclusion,
  DomainError,
  selectCheckAnnotations,
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
  it('allows a valid transition and rejects a terminal transition', () => {
    expect(() => {
      assertRunTransition('ACCEPTED', 'QUEUED');
    }).not.toThrow();
    expect(() => {
      assertRunTransition('SUCCEEDED', 'RUNNING');
    }).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
  });

  it('covers every allowed task and external-effect recovery transition', () => {
    expect(() => {
      assertTaskTransition('PENDING', 'LEASED');
    }).not.toThrow();
    expect(() => {
      assertTaskTransition('LEASED', 'RETRY_WAIT');
    }).not.toThrow();
    expect(() => {
      assertTaskTransition('RETRY_WAIT', 'LEASED');
    }).not.toThrow();
    expect(() => {
      assertTaskTransition('FAILED', 'LEASED');
    }).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    expect(() => {
      assertExternalEffectTransition('PREPARED', 'IN_FLIGHT');
    }).not.toThrow();
    expect(() => {
      assertExternalEffectTransition('IN_FLIGHT', 'UNKNOWN');
    }).not.toThrow();
    expect(() => {
      assertExternalEffectTransition('UNKNOWN', 'SUCCEEDED');
    }).not.toThrow();
    expect(() => {
      assertExternalEffectTransition('SUCCEEDED', 'IN_FLIGHT');
    }).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
  });
});

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
        finding({ fingerprint: 'info', severity: 'INFO' }),
      ],
      2,
    );
    expect(selected.map((candidate) => candidate.fingerprint)).toEqual(['a-major', 'z-major']);
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
  });
});
