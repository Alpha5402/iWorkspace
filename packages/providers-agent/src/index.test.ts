import { describe, expect, it } from 'vitest';

import { agentProviderCapability } from './index.js';

describe('agent provider boundary', () => {
  it('does not expose a fake provider in M0', () => {
    expect(agentProviderCapability).toEqual({ implemented: false, plannedPhase: 'M1' });
  });
});
