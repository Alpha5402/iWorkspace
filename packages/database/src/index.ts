import { type DependencyProbe } from '@delivery/health';
import pg from 'pg';

type PostgresHealthClient = Readonly<{
  end(): Promise<void>;
  query(sql: string): Promise<unknown>;
}>;

type PostgresHealthClientFactory = (connectionString: string) => PostgresHealthClient;

const createDefaultClient: PostgresHealthClientFactory = (connectionString) =>
  new pg.Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 2 });

export function createPostgresProbe(
  connectionString: string,
  clientFactory: PostgresHealthClientFactory = createDefaultClient,
): DependencyProbe {
  const client = clientFactory(connectionString);

  return {
    name: 'postgres',
    async check() {
      try {
        await client.query('SELECT 1');
        return { name: 'postgres', status: 'up' };
      } catch {
        return { name: 'postgres', status: 'down' };
      }
    },
    async close() {
      await client.end();
    },
  };
}
