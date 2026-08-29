import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_object_key_key;
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_run_type_hash_unique
      UNIQUE (run_id, artifact_type, content_hash);
  `);
}

export function down(): never {
  throw new Error('Artifact metadata identity migration is forward-only.');
}
