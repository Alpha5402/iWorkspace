import { type PlannedPhaseSchema } from '@delivery/contracts';
import { type z } from 'zod';

type PlannedPhase = z.infer<typeof PlannedPhaseSchema>;

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class CapabilityNotImplementedError extends HttpError {
  public constructor(
    public readonly capability: string,
    public readonly plannedPhase: PlannedPhase,
  ) {
    super(
      501,
      'FEATURE_NOT_IMPLEMENTED',
      `${capability} is planned for ${plannedPhase} and is not implemented in M0.`,
    );
    this.name = 'CapabilityNotImplementedError';
  }
}
