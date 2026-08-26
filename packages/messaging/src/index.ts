import { type DependencyProbe } from '@delivery/health';
import { connect } from 'amqplib';

type RabbitMqHealthConnection = Readonly<{
  close(): Promise<void>;
}>;

type RabbitMqConnector = (url: string) => Promise<RabbitMqHealthConnection>;

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
