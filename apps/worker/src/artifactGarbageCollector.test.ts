import { describe, expect, it, vi } from 'vitest';

import { ArtifactGarbageCollector } from './artifactGarbageCollector.js';

const NOW = new Date('2026-08-30T00:00:00.000Z');
const STALE = new Date('2026-08-28T00:00:00.000Z');
const FRESH = new Date('2026-08-29T12:00:00.000Z');

describe('ArtifactGarbageCollector', () => {
  it('removes stale temporary objects and only unreferenced stale artifact objects', async () => {
    const deleted: string[] = [];
    const store = {
      delete: vi.fn((key: string) => {
        deleted.push(key);
        return Promise.resolve();
      }),
      list: vi.fn((prefix: 'artifacts/' | 'tmp/') =>
        Promise.resolve({
          objects:
            prefix === 'tmp/'
              ? [
                  { key: 'tmp/stale', lastModified: STALE, sizeBytes: 1 },
                  { key: 'tmp/fresh', lastModified: FRESH, sizeBytes: 1 },
                ]
              : [
                  { key: 'artifacts/referenced', lastModified: STALE, sizeBytes: 1 },
                  { key: 'artifacts/orphaned', lastModified: STALE, sizeBytes: 1 },
                  { key: 'artifacts/fresh', lastModified: FRESH, sizeBytes: 1 },
                ],
        }),
      ),
    };
    const lookup = vi.fn(() => Promise.resolve(['artifacts/referenced']));
    const collector = new ArtifactGarbageCollector(lookup, store, options());

    await expect(collector.runOnce()).resolves.toEqual({
      deletedArtifactObjects: 1,
      deletedTemporaryObjects: 1,
      inspectedObjects: 5,
    });
    expect(new Set(deleted)).toEqual(new Set(['tmp/stale', 'artifacts/orphaned']));
    expect(lookup).toHaveBeenCalledWith(['artifacts/referenced', 'artifacts/orphaned']);
  });

  it('uses bounded pagination and coalesces overlapping scheduled sweeps', async () => {
    let releaseLookup: (() => void) | undefined;
    const lookup = vi.fn(
      () =>
        new Promise<readonly string[]>((resolve) => {
          releaseLookup = () => {
            resolve([]);
          };
        }),
    );
    const store = {
      delete: vi.fn(() => Promise.resolve()),
      list: vi
        .fn()
        .mockResolvedValueOnce({ objects: [] })
        .mockResolvedValueOnce({
          continuationToken: 'next',
          objects: [{ key: 'artifacts/one', lastModified: STALE, sizeBytes: 1 }],
        })
        .mockResolvedValueOnce({
          objects: [{ key: 'artifacts/two', lastModified: STALE, sizeBytes: 1 }],
        }),
    };
    const collector = new ArtifactGarbageCollector(lookup, store, {
      ...options(),
      maximumObjectsPerSweep: 2,
    });

    const first = collector.runOnce();
    const overlapping = collector.runOnce();
    expect(overlapping).toBe(first);
    await vi.waitFor(() => {
      expect(releaseLookup).toBeTypeOf('function');
    });
    releaseLookup?.();
    await expect(first).resolves.toMatchObject({ deletedArtifactObjects: 2, inspectedObjects: 2 });
    expect(store.list).toHaveBeenCalledTimes(3);
    await collector.close();
  });

  it('starts once, reports scheduled failures, and stops cleanly', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const store = {
      delete: vi.fn(() => Promise.resolve()),
      list: vi.fn(() => Promise.reject(new Error('storage unavailable'))),
    };
    const collector = new ArtifactGarbageCollector(() => Promise.resolve([]), store, {
      intervalMilliseconds: 1_000,
      maximumObjectsPerSweep: 100,
      minimumAgeMilliseconds: 86_400_000,
      onError,
    });

    collector.start();
    collector.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
    });
    await collector.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.list).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

function options(): Readonly<{
  intervalMilliseconds: number;
  maximumObjectsPerSweep: number;
  minimumAgeMilliseconds: number;
  now: () => Date;
}> {
  return {
    intervalMilliseconds: 60_000,
    maximumObjectsPerSweep: 100,
    minimumAgeMilliseconds: 24 * 60 * 60 * 1_000,
    now: () => NOW,
  };
}
