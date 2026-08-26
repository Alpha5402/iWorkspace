import { RunStatusSchema } from '@delivery/contracts';
import { describe, expect, it } from 'vitest';

import { runStatusPresentation } from './runStatus.js';

describe('Run status presentation contract', () => {
  it('covers every frozen Run status', () => {
    for (const status of RunStatusSchema.options) {
      expect(runStatusPresentation[status].label).not.toHaveLength(0);
    }
  });
});
