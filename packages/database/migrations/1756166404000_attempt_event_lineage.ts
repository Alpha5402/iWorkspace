import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`ALTER TABLE task_attempts ADD COLUMN source_event_id uuid;`);
}

export function down(): never {
  throw new Error('Attempt event lineage migration is forward-only.');
}
