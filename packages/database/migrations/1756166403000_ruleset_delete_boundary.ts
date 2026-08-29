import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP TRIGGER IF EXISTS ruleset_versions_immutable ON ruleset_versions;
    CREATE TRIGGER ruleset_versions_immutable BEFORE UPDATE ON ruleset_versions
      FOR EACH ROW EXECUTE FUNCTION reject_published_ruleset_mutation();
    REVOKE DELETE ON ruleset_versions FROM iw_api, iw_worker;
  `);
}

export function down(): never {
  throw new Error('Ruleset immutability correction is forward-only.');
}
