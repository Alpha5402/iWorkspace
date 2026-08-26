import { describe, expect, it } from 'vitest';

import { createEnvironment } from './index.js';

describe('test environment factory', () => {
  it('provides safe defaults and explicit overrides', () => {
    expect(createEnvironment({ LOG_LEVEL: 'debug' })).toMatchObject({
      LOG_LEVEL: 'debug',
      NODE_ENV: 'test',
    });
  });
});
