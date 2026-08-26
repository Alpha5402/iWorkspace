import { describe, expect, it } from 'vitest';

import { DomainError } from './index.js';

describe('DomainError', () => {
  it('preserves a stable code and message', () => {
    const error = new DomainError('INVALID_TRANSITION', 'The transition is not allowed.');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.message).toBe('The transition is not allowed.');
  });
});
