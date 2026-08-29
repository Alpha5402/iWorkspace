import { type Kysely, sql, type Transaction } from 'kysely';

import { type DatabaseSchema } from './schema.js';

type DatabaseExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export async function getDatabaseNow(executor: DatabaseExecutor): Promise<Date> {
  const result = await sql<{ database_now: Date }>`select now() as database_now`.execute(executor);
  const row = result.rows[0];
  if (row === undefined) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
  return row.database_now;
}
