import { describe, expect, it, vi } from 'vitest';

import { createRabbitMqProbe } from './index.js';

describe('RabbitMQ health probe', () => {
  it('opens and closes a health connection', async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue();
    const connector = vi.fn().mockResolvedValue({ close });
    const probe = createRabbitMqProbe('amqp://example', connector);

    await expect(probe.check()).resolves.toEqual({ name: 'rabbitmq', status: 'up' });
    expect(connector).toHaveBeenCalledWith('amqp://example');
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports down without exposing connector errors', async () => {
    const probe = createRabbitMqProbe('amqp://example', () =>
      Promise.reject(new Error('secret broker detail')),
    );

    await expect(probe.check()).resolves.toEqual({ name: 'rabbitmq', status: 'down' });
  });
});
