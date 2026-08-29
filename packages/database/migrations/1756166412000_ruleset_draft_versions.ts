import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE UNIQUE INDEX ruleset_versions_one_draft_per_ruleset
      ON ruleset_versions(ruleset_id)
      WHERE status = 'DRAFT';
  `);
}

export function down(): never {
  throw new Error('Ruleset draft version migration is forward-only.');
}
