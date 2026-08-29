import { type DependencyProbe } from '@delivery/health';
import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';

type RabbitMqHealthConnection = Readonly<{
  close(): Promise<void>;
}>;

type RabbitMqConnector = (url: string) => Promise<RabbitMqHealthConnection>;
type RabbitMqBusConnector = (url: string) => Promise<ChannelModel>;

const defaultConnector: RabbitMqConnector = async (url) => connect(url, { timeout: 2_000 });

export function createRabbitMqProbe(
  url: string,
  connector: RabbitMqConnector = defaultConnector,
): DependencyProbe {
  return {
    name: 'rabbitmq',
    async check() {
      try {
        const connection = await connector(url);
        await connection.close();
        return { name: 'rabbitmq', status: 'up' };
      } catch {
        return { name: 'rabbitmq', status: 'down' };
      }
    },
  };
}

export const REVIEW_EXCHANGE = 'iw.commands';
export const EVENT_EXCHANGE = 'iw.events';
export const DEAD_LETTER_EXCHANGE = 'iw.dlx';

export const reviewQueues = {
  analyze: 'review.analyze',
  acquire: 'review.acquire',
  publish: 'review.publish',
  verify: 'review.verify',
} as const;

export type PublishedEvent = Readonly<{
  causationId?: string;
  correlationId: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date;
  organizationId: string;
  payload: Record<string, unknown>;
  projectId: string;
  traceparent?: string;
}>;

export class RabbitMqBus {
  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
  ) {}

  public static async connect(
    url: string,
    connector: RabbitMqBusConnector = connect,
  ): Promise<RabbitMqBus> {
    const connection = await connector(url);
    const channel = await connection.createConfirmChannel();
    const bus = new RabbitMqBus(connection, channel);
    await bus.assertTopology();
    return bus;
  }

  public async publish(event: PublishedEvent): Promise<void> {
    const routingKey = event.eventType;
    this.channel.publish(
      REVIEW_EXCHANGE,
      routingKey,
      Buffer.from(
        JSON.stringify({
          ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
          correlationId: event.correlationId,
          eventId: event.eventId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          occurredAt: event.occurredAt.toISOString(),
          organizationId: event.organizationId,
          payload: event.payload,
          projectId: event.projectId,
          ...(event.traceparent === undefined ? {} : { traceparent: event.traceparent }),
        }),
      ),
      {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: event.eventId,
        timestamp: Math.floor(event.occurredAt.getTime() / 1_000),
        type: event.eventType,
      },
    );
    await this.channel.waitForConfirms();
  }

  public async consume(
    queue: (typeof reviewQueues)[keyof typeof reviewQueues],
    handler: (message: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    await this.channel.prefetch(4);
    await this.channel.consume(queue, (message) => {
      if (message === null) return;
      void handler(message)
        .then(() => {
          this.channel.ack(message);
        })
        .catch(() => {
          this.channel.nack(message, false, false);
        });
    });
  }

  public close(): Promise<void> {
    return this.connection.close();
  }

  private async assertTopology(): Promise<void> {
    await this.channel.assertExchange(REVIEW_EXCHANGE, 'direct', { durable: true });
    await this.channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });
    await this.channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
    for (const [routingName, queue] of Object.entries(reviewQueues)) {
      const routingKey = `review.${routingName}.requested`;
      await this.channel.assertQueue(queue, {
        arguments: {
          'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
          'x-dead-letter-routing-key': `${queue}.dead`,
          // Backpressure may legitimately keep work queued for hours. Execution deadlines
          // begin after leasing; this TTL only prevents abandoned commands living forever.
          'x-message-ttl': 24 * 60 * 60 * 1_000,
        },
        durable: true,
      });
      await this.channel.bindQueue(queue, REVIEW_EXCHANGE, routingKey);
      const deadQueue = `${queue}.dlq`;
      await this.channel.assertQueue(deadQueue, { durable: true });
      await this.channel.bindQueue(deadQueue, DEAD_LETTER_EXCHANGE, `${queue}.dead`);
    }
  }
}
