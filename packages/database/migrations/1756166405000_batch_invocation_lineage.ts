import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE review_batches ADD COLUMN provider_invocation_id uuid
      REFERENCES provider_invocations(id);
  `);
}

export function down(): never {
  throw new Error('Batch invocation lineage migration is forward-only.');
}
