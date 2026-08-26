import { describe, expect, it, vi } from 'vitest';

import { createDockerProbe } from './dockerProbe.js';

describe('Docker readiness probe', () => {
  it('reports an available daemon', async () => {
    const ping = vi.fn<() => Promise<unknown>>().mockResolvedValue('OK');

    await expect(createDockerProbe({ ping }).check()).resolves.toEqual({
      name: 'docker',
      status: 'up',
    });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('reports down without exposing daemon errors', async () => {
    const probe = createDockerProbe({
      ping: () => Promise.reject(new Error('/var/run/docker.sock secret detail')),
    });

    await expect(probe.check()).resolves.toEqual({ name: 'docker', status: 'down' });
  });
});
