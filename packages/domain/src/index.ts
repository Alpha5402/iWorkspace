import { createHash } from 'node:crypto';

export class DomainError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const runStatuses = [
  'ACCEPTED',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
  'STALE',
] as const;
export type RunStatus = (typeof runStatuses)[number];

export const taskStatuses = [
  'PENDING',
  'LEASED',
  'SUCCEEDED',
  'RETRY_WAIT',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const externalEffectStatuses = [
  'PREPARED',
  'IN_FLIGHT',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
] as const;
export type ExternalEffectStatus = (typeof externalEffectStatuses)[number];

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

function assertTransition<TStatus extends string>(
  transitions: Readonly<Record<TStatus, readonly TStatus[]>>,
  current: TStatus,
  next: TStatus,
  subject: string,
): void {
  if (!transitions[current].includes(next)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `${subject} cannot transition from ${current} to ${next}`,
    );
  }
}

export const assertRunTransition = (current: RunStatus, next: RunStatus): void => {
  assertTransition(runTransitions, current, next, 'run');
};

export const assertTaskTransition = (current: TaskStatus, next: TaskStatus): void => {
  assertTransition(taskTransitions, current, next, 'task');
};

export const assertExternalEffectTransition = (
  current: ExternalEffectStatus,
  next: ExternalEffectStatus,
): void => {
  assertTransition(externalEffectTransitions, current, next, 'external effect');
};

export const findingSeverities = ['BLOCKING', 'MAJOR', 'MINOR', 'INFO'] as const;
export type FindingSeverity = (typeof findingSeverities)[number];
export const findingVerificationStatuses = [
  'CONFIRMED',
  'DISPUTED',
  'REJECTED',
  'NEEDS_HUMAN',
] as const;
export type FindingVerificationStatus = (typeof findingVerificationStatuses)[number];

export type ReviewFinding = Readonly<{
  batchId?: string;
  confidence: number;
  description: string;
  endLine: number;
  evidence: readonly string[];
  fingerprint: string;
  path: string;
  ruleId: string;
  severity: FindingSeverity;
  startLine: number;
  title: string;
  verificationStatus: FindingVerificationStatus;
}>;

export function createFindingFingerprint(
  input: Readonly<{
    codeIdentity: string;
    message: string;
    path: string;
    ruleId: string;
  }>,
): string {
  const normalizedMessage = input.message.trim().toLocaleLowerCase().replaceAll(/\s+/g, ' ');
  return createHash('sha256')
    .update([input.ruleId, input.path, input.codeIdentity, normalizedMessage].join('\0'))
    .digest('hex');
}

export type CheckConclusion =
  'success' | 'failure' | 'neutral' | 'action_required' | 'cancelled' | 'timed_out';

export function determineCheckConclusion(
  input: Readonly<{
    coverageComplete: boolean;
    findings: readonly ReviewFinding[];
    runStatus: RunStatus;
  }>,
): CheckConclusion {
  if (input.runStatus === 'CANCELLED' || input.runStatus === 'STALE') return 'cancelled';
  if (input.runStatus === 'FAILED') return 'action_required';
  if (
    input.findings.some(
      (finding) => finding.severity === 'BLOCKING' && finding.verificationStatus === 'CONFIRMED',
    )
  ) {
    return 'failure';
  }
  if (
    input.findings.some(
      (finding) => finding.severity === 'BLOCKING' && finding.verificationStatus === 'NEEDS_HUMAN',
    )
  ) {
    return 'action_required';
  }
  return input.coverageComplete ? 'success' : 'neutral';
}

export function selectCheckAnnotations(
  findings: readonly ReviewFinding[],
  limit = 50,
): readonly ReviewFinding[] {
  const rank: Readonly<Record<FindingSeverity, number>> = {
    BLOCKING: 0,
    MAJOR: 1,
    MINOR: 2,
    INFO: 3,
  };
  return findings
    .filter(
      (finding) =>
        finding.verificationStatus === 'CONFIRMED' &&
        finding.startLine > 0 &&
        finding.endLine >= finding.startLine,
    )
    .toSorted(
      (left, right) =>
        rank[left.severity] - rank[right.severity] ||
        right.confidence - left.confidence ||
        left.fingerprint.localeCompare(right.fingerprint),
    )
    .slice(0, limit);
}
