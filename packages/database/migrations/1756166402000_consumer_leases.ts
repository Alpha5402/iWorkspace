import { type MigrationBuilder } from 'node-pg-migrate';

export const shorthands = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE consumer_inbox
      ADD COLUMN claimed_by text,
      ADD COLUMN claimed_until timestamptz;
    CREATE INDEX consumer_inbox_recoverable_idx
      ON consumer_inbox(claimed_until)
      WHERE completed_at IS NULL;
  `);
}

export function down(): never {
  throw new Error('Consumer lease migration is forward-only.');
}
