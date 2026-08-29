import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE INDEX users_admin_created_id_idx
      ON users(created_at DESC, id DESC);
  `);
}

export function down(): never {
  throw new Error('Platform administrator user-list index migration is forward-only.');
}
