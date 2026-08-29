import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPlatformAdminDatabase, type DeliveryDatabase } from './index.js';

const describeInfrastructure =
  process.env.RUN_INFRA_INTEGRATION === 'true' ? describe : describe.skip;

describeInfrastructure('platform administrator database role', () => {
  let administratorDatabase: DeliveryDatabase;
  let database: DeliveryDatabase;
  const userId = randomUUID();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
    database = createDatabase(databaseUrl);
    administratorDatabase = createPlatformAdminDatabase(databaseUrl);
    await database
      .insertInto('users')
      .values({
        email: `${userId}@example.com`,
        id: userId,
        platform_role: 'USER',
        status: 'ACTIVE',
      })
      .executeTakeFirstOrThrow();
  });

  afterAll(async () => {
    await database.deleteFrom('users').where('id', '=', userId).execute();
    await administratorDatabase.destroy();
    await database.destroy();
  });

  it('can manage user state but cannot read tenant project data', async () => {
    const role = await sql<{ role: string }>`select current_user as role`
      .execute(administratorDatabase)
      .then((result) => result.rows[0]?.role);
    expect(role).toBe('iw_platform_admin');
    await expect(
      administratorDatabase
        .updateTable('users')
        .set({ status: 'SUSPENDED' })
        .where('id', '=', userId)
        .returning('status')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'SUSPENDED' });
    await expect(
      administratorDatabase.selectFrom('projects').select('id').execute(),
    ).rejects.toThrow(/permission denied/i);
  });
});
