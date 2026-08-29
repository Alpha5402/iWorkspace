import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE VIEW platform_admin_user_token_metadata
      WITH (security_barrier = true)
    AS
      SELECT
        project_api_tokens.id,
        project_api_tokens.created_by,
        project_api_tokens.created_at,
        project_api_tokens.expires_at,
        project_api_tokens.name,
        project_api_tokens.project_id,
        projects.name AS project_name,
        project_api_tokens.revoked_at,
        project_api_tokens.scopes,
        project_api_tokens.token_prefix
      FROM project_api_tokens
      INNER JOIN projects ON projects.id = project_api_tokens.project_id;

    REVOKE ALL ON platform_admin_user_token_metadata FROM PUBLIC;
    GRANT SELECT ON platform_admin_user_token_metadata TO iw_platform_admin;
  `);
}

export function down(): never {
  throw new Error('Platform administrator token metadata migration is forward-only.');
}
