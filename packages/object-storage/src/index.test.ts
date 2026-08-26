import { describe, expect, it, vi } from 'vitest';

import { createObjectStorageProbe, type ObjectStorageConfig } from './index.js';

const config: ObjectStorageConfig = {
  accessKeyId: 'test',
  bucket: 'artifacts',
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  secretAccessKey: 'not-real',
};

describe('object storage health probe', () => {
  it('checks the configured bucket and destroys the client', async () => {
    const send = vi.fn().mockResolvedValue({});
    const destroy = vi.fn();
    const probe = createObjectStorageProbe(config, () => ({ destroy, send }));

    await expect(probe.check()).resolves.toEqual({ name: 'objectStorage', status: 'up' });
    expect(send).toHaveBeenCalledOnce();
    await probe.close?.();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('reports down without exposing storage errors', async () => {
    const probe = createObjectStorageProbe(config, () => ({
      destroy: () => undefined,
      send: () => Promise.reject(new Error('secret storage detail')),
    }));

    await expect(probe.check()).resolves.toEqual({ name: 'objectStorage', status: 'down' });
  });
});
