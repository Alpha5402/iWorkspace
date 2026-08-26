import { once } from 'node:events';
import { type AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import {
  createProcessHealthServer,
  createReadinessProbe,
  evaluateProcessHealthRequest,
  type DependencyProbe,
} from './index.js';

describe('readiness', () => {
  it('reports all dependencies and closes managed probes', async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    const probes: DependencyProbe[] = [
      {
        name: 'postgres',
        check: () => Promise.resolve({ name: 'postgres', status: 'up' }),
        close,
      },
      {
        name: 'rabbitmq',
        check: () => Promise.resolve({ name: 'rabbitmq', status: 'down' }),
      },
    ];
    const readiness = createReadinessProbe(probes);

    await expect(readiness.check()).resolves.toEqual({
      dependencies: {
        postgres: { status: 'up' },
        rabbitmq: { status: 'down' },
      },
      ready: false,
    });
    await readiness.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('evaluates liveness, readiness, not-found, and probe-failure responses', async () => {
    const readiness = createReadinessProbe([
      { name: 'docker', check: () => Promise.resolve({ name: 'docker', status: 'up' }) },
    ]);
    const options = {
      host: '127.0.0.1',
      port: 0,
      readinessProbe: readiness,
      service: 'test-process',
    } as const;

    await expect(evaluateProcessHealthRequest(options, '/health/live')).resolves.toEqual({
      body: { service: 'test-process', status: 'ok' },
      statusCode: 200,
    });
    await expect(evaluateProcessHealthRequest(options, '/health/ready')).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(evaluateProcessHealthRequest(options, '/missing')).resolves.toMatchObject({
      statusCode: 404,
    });

    const failingOptions = {
      host: '127.0.0.1',
      port: 0,
      readinessProbe: {
        check: () => Promise.reject(new Error('secret infrastructure detail')),
        close: () => Promise.resolve(),
      },
      service: 'failing-process',
    } as const;
    const failed = await evaluateProcessHealthRequest(failingOptions, '/health/ready');

    expect(failed.statusCode).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('secret infrastructure detail');

    const server = createProcessHealthServer(options);
    expect(server.listening).toBe(false);
    server.close();
  });

  it('serves a traced health response and closes the span with the HTTP status', async () => {
    const end = vi.fn<(statusCode: number) => void>();
    const readiness = createReadinessProbe([]);
    const server = createProcessHealthServer({
      host: '127.0.0.1',
      port: 0,
      readinessProbe: readiness,
      service: 'traced-process',
      startSpan: () => ({ end, traceId: 'a'.repeat(32) }),
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${String(port)}/health/live`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-trace-id')).toBe('a'.repeat(32));
      await expect(response.json()).resolves.toMatchObject({
        service: 'traced-process',
        traceId: 'a'.repeat(32),
      });
      expect(end).toHaveBeenCalledWith(200);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
