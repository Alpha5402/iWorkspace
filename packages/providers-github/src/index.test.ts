import { describe, expect, it } from 'vitest';

import { githubProviderCapability } from './index.js';

describe('GitHub provider boundary', () => {
  it('does not expose a fake provider in M0', () => {
    expect(githubProviderCapability).toEqual({ implemented: false, plannedPhase: 'M1' });
  });
});
