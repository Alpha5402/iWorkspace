import { type DependencyProbe } from '@delivery/health';
import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';

type RabbitMqHealthConnection = Readonly<{
  close(): Promise<void>;
}>;

type RabbitMqConnector = (url: string) => Promise<RabbitMqHealthConnection>;
type RabbitMqBusConnector = (url: string) => Promise<ChannelModel>;
type ReviewQueue = (typeof reviewQueues)[keyof typeof reviewQueues];
type ConsumerHandler = (message: ConsumeMessage) => Promise<void>;

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
  private channel: ConfirmChannel | undefined;
  private closed = false;
  private connecting: Promise<ConfirmChannel> | undefined;
  private connection: ChannelModel | undefined;
  private reconnectDelayMilliseconds = 250;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly subscriptions = new Map<ReviewQueue, ConsumerHandler>();

  private constructor(
    private readonly url: string,
    private readonly connector: RabbitMqBusConnector,
  ) {}

  public static async connect(
    url: string,
    connector: RabbitMqBusConnector = connect,
  ): Promise<RabbitMqBus> {
    const bus = new RabbitMqBus(url, connector);
    await bus.ensureChannel();
    return bus;
  }

  public async publish(event: PublishedEvent): Promise<void> {
    const channel = await this.ensureChannel();
    try {
      channel.publish(
        REVIEW_EXCHANGE,
        event.eventType,
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
      await channel.waitForConfirms();
    } catch (error) {
      this.disconnectChannel(channel);
      throw error;
    }
  }

  public async consume(queue: ReviewQueue, handler: ConsumerHandler): Promise<void> {
    const connectedChannel = this.channel;
    this.subscriptions.set(queue, handler);
    if (connectedChannel === undefined) await this.ensureChannel();
    else await this.startConsumer(connectedChannel, queue, handler);
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await this.connecting?.catch(() => undefined);
    this.channel = undefined;
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) await connection.close();
  }

  private async startConsumer(
    channel: ConfirmChannel,
    queue: ReviewQueue,
    handler: ConsumerHandler,
  ): Promise<void> {
    await channel.prefetch(4);
    await channel.consume(queue, (message) => {
      if (message === null) return;
      void handler(message)
        .then(() => {
          try {
            channel.ack(message);
          } catch {
            // A closed channel causes RabbitMQ to redeliver. Consumer Inbox makes this safe.
          }
        })
        .catch(() => {
          try {
            channel.nack(message, false, false);
          } catch {
            // The broker will redeliver an unacknowledged message after reconnecting.
          }
        });
    });
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (this.closed) throw new Error('RABBITMQ_BUS_CLOSED');
    if (this.channel !== undefined) return this.channel;
    if (this.connecting !== undefined) return this.connecting;
    const connecting = this.connectChannel();
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private async connectChannel(): Promise<ConfirmChannel> {
    const connection = await this.connector(this.url);
    try {
      if (this.closed) {
        await connection.close();
        throw new Error('RABBITMQ_BUS_CLOSED');
      }
      const channel = await connection.createConfirmChannel();
      await this.assertTopology(channel);
      connection.on('error', () => undefined);
      channel.on('error', () => undefined);
      connection.on('close', () => {
        this.disconnectConnection(connection);
      });
      channel.on('close', () => {
        this.disconnectChannel(channel);
      });
      this.connection = connection;
      this.channel = channel;
      this.reconnectDelayMilliseconds = 250;
      await Promise.all(
        [...this.subscriptions].map(([queue, handler]) =>
          this.startConsumer(channel, queue, handler),
        ),
      );
      return channel;
    } catch (error) {
      if (this.connection === connection) this.connection = undefined;
      this.channel = undefined;
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private disconnectConnection(connection: ChannelModel): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.channel = undefined;
    this.scheduleReconnect();
  }

  private disconnectChannel(channel: ConfirmChannel): void {
    if (this.channel !== channel) return;
    this.channel = undefined;
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) void connection.close().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.subscriptions.size === 0 || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelayMilliseconds;
    this.reconnectDelayMilliseconds = Math.min(delay * 2, 5_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureChannel().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private async assertTopology(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(REVIEW_EXCHANGE, 'direct', { durable: true });
    await channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
    for (const [routingName, queue] of Object.entries(reviewQueues)) {
      const routingKey = `review.${routingName}.requested`;
      await channel.assertQueue(queue, {
        arguments: {
          'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
          'x-dead-letter-routing-key': `${queue}.dead`,
          // Backpressure may legitimately keep work queued for hours. Execution deadlines
          // begin after leasing; this TTL only prevents abandoned commands living forever.
          'x-message-ttl': 24 * 60 * 60 * 1_000,
        },
        durable: true,
      });
      await channel.bindQueue(queue, REVIEW_EXCHANGE, routingKey);
      const deadQueue = `${queue}.dlq`;
      await channel.assertQueue(deadQueue, { durable: true });
      await channel.bindQueue(deadQueue, DEAD_LETTER_EXCHANGE, `${queue}.dead`);
    }
  }
}
