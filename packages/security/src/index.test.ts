import { describe, expect, it } from 'vitest';

import { securityCapability } from './index.js';

describe('security capability boundary', () => {
  it('is explicitly unavailable before M1', () => {
    expect(securityCapability).toEqual({ implemented: false, plannedPhase: 'M1' });
    expect(Object.isFrozen(securityCapability)).toBe(true);
  });
});
