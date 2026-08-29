import { describe, expect, it, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';

import { RabbitMqBus, REVIEW_EXCHANGE, createRabbitMqProbe, reviewQueues } from './index.js';

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

  it('declares durable review and dead-letter topology and publishes a complete envelope', async () => {
    const channel = createChannel();
    const connection = {
      close: vi.fn().mockResolvedValue(undefined),
      createConfirmChannel: vi.fn().mockResolvedValue(channel),
    };
    const bus = await RabbitMqBus.connect('amqp://example', vi.fn().mockResolvedValue(connection));
    expect(channel.assertQueue).toHaveBeenCalledTimes(Object.keys(reviewQueues).length * 2);
    expect(channel.bindQueue).toHaveBeenCalledTimes(Object.keys(reviewQueues).length * 2);

    const eventId = randomUUID();
    await bus.publish({
      causationId: randomUUID(),
      correlationId: 'correlation',
      eventId,
      eventType: 'review.acquire.requested',
      eventVersion: 1,
      occurredAt: new Date('2026-08-26T00:00:00.000Z'),
      organizationId: randomUUID(),
      payload: { runId: randomUUID() },
      projectId: randomUUID(),
      traceparent: '00-trace-parent',
    });
    expect(channel.publish).toHaveBeenCalledWith(
      REVIEW_EXCHANGE,
      'review.acquire.requested',
      expect.any(Buffer),
      expect.objectContaining({ deliveryMode: 2, messageId: eventId }),
    );
    const body = JSON.parse(
      vi.mocked(channel.publish).mock.calls[0]?.[2].toString('utf8') ?? '',
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ correlationId: 'correlation', traceparent: '00-trace-parent' });
    expect(channel.waitForConfirms).toHaveBeenCalledOnce();
    await bus.close();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('ACKs successful deliveries, NACKs failed deliveries, and ignores consumer cancellation', async () => {
    const channel = createChannel();
    const connection = {
      close: vi.fn().mockResolvedValue(undefined),
      createConfirmChannel: vi.fn().mockResolvedValue(channel),
    };
    const bus = await RabbitMqBus.connect('amqp://example', () =>
      Promise.resolve(connection as unknown as ChannelModel),
    );
    const handler = vi
      .fn<(message: ConsumeMessage) => Promise<void>>()
      .mockResolvedValue(undefined);
    await bus.consume(reviewQueues.acquire, handler);
    const callback = vi.mocked(channel.consume).mock.calls[0]?.[1];
    const message = { content: Buffer.from('{}') } as ConsumeMessage;
    callback?.(message);
    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalledWith(message);
    });

    handler.mockRejectedValueOnce(new Error('failed'));
    callback?.(message);
    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    });
    callback?.(null);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

function createChannel(): ConfirmChannel {
  return {
    ack: vi.fn(),
    assertExchange: vi.fn().mockResolvedValue({ exchange: '' }),
    assertQueue: vi.fn().mockResolvedValue({ consumerCount: 0, messageCount: 0, queue: '' }),
    bindQueue: vi.fn().mockResolvedValue({}),
    consume: vi.fn().mockResolvedValue({ consumerTag: 'consumer' }),
    nack: vi.fn(),
    prefetch: vi.fn().mockResolvedValue({}),
    publish: vi.fn().mockReturnValue(true),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConfirmChannel;
}
