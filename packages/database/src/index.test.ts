import { describe, expect, it, vi } from 'vitest';

import { createPostgresProbe } from './index.js';

describe('PostgreSQL health probe', () => {
  it('reports up and closes the client', async () => {
    const query = vi.fn<(sql: string) => Promise<unknown>>().mockResolvedValue({ rows: [] });
    const end = vi.fn<() => Promise<void>>().mockResolvedValue();
    const probe = createPostgresProbe('postgresql://example', () => ({ end, query }));

    await expect(probe.check()).resolves.toEqual({ name: 'postgres', status: 'up' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    await probe.close?.();
    expect(end).toHaveBeenCalledOnce();
  });

  it('does not leak connection errors', async () => {
    const probe = createPostgresProbe('postgresql://example', () => ({
      end: () => Promise.resolve(),
      query: () => Promise.reject(new Error('password=do-not-leak')),
    }));

    await expect(probe.check()).resolves.toEqual({ name: 'postgres', status: 'down' });
  });
});
