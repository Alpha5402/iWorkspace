import { describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand } from '@aws-sdk/client-s3';

import {
  createObjectStorageProbe,
  ImmutableArtifactStore,
  type ObjectStorageConfig,
} from './index.js';

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

describe('immutable artifact store', () => {
  it('verifies a temporary upload before promoting its content-addressed key', async () => {
    const send = vi
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        ContentLength: 5,
        Metadata: { sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const store = new ImmutableArtifactStore(config, () => ({ destroy: vi.fn(), send }));
    const result = await store.put({
      body: Buffer.from('hello'),
      mediaType: 'text/plain',
      organizationId: 'organization',
      projectId: 'project',
      runId: 'run',
    });
    expect(result).toEqual({
      contentHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      objectKey:
        'artifacts/organization/project/run/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      sizeBytes: 5,
    });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('cleans the temporary object when verification fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 4, Metadata: {} })
      .mockResolvedValueOnce({});
    const store = new ImmutableArtifactStore(config, () => ({ destroy: vi.fn(), send }));
    await expect(
      store.put({
        body: Buffer.from('hello'),
        mediaType: 'text/plain',
        organizationId: 'organization',
        projectId: 'project',
        runId: 'run',
      }),
    ).rejects.toThrow('ARTIFACT_UPLOAD_VERIFICATION_FAILED');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not promote an artifact after its fencing guard is rejected', async () => {
    const send = vi
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        ContentLength: 5,
        Metadata: { sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
      })
      .mockResolvedValueOnce({});
    const store = new ImmutableArtifactStore(config, () => ({ destroy: vi.fn(), send }));

    await expect(
      store.put({
        beforeCommit: () => Promise.reject(new Error('TASK_FENCING_REJECTED')),
        body: Buffer.from('hello'),
        mediaType: 'text/plain',
        organizationId: 'organization',
        projectId: 'project',
        runId: 'run',
      }),
    ).rejects.toThrow('TASK_FENCING_REJECTED');
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.some(([command]) => command instanceof CopyObjectCommand)).toBe(false);
  });

  it('reads immutable bytes and destroys the storage client', async () => {
    const destroy = vi.fn();
    const send = vi.fn().mockResolvedValue({
      Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from([1, 2, 3])) },
    });
    const store = new ImmutableArtifactStore(config, () => ({ destroy, send }));
    await expect(store.get('artifacts/object')).resolves.toEqual(Buffer.from([1, 2, 3]));
    store.close();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('fails closed when object storage omits the response body', async () => {
    const store = new ImmutableArtifactStore(config, () => ({
      destroy: vi.fn(),
      send: vi.fn().mockResolvedValue({}),
    }));
    await expect(store.get('artifacts/missing')).rejects.toThrow('ARTIFACT_BODY_MISSING');
  });
});
