import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE refresh_sessions ADD COLUMN ip_address text;
    ALTER TABLE refresh_sessions ADD COLUMN user_agent text;
    ALTER TABLE refresh_sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE refresh_sessions ADD CONSTRAINT refresh_sessions_ip_address_length
      CHECK (ip_address IS NULL OR length(ip_address) <= 255);
    ALTER TABLE refresh_sessions ADD CONSTRAINT refresh_sessions_user_agent_length
      CHECK (user_agent IS NULL OR length(user_agent) <= 512);
    CREATE INDEX refresh_sessions_user_family_created_idx
      ON refresh_sessions(user_id, family_id, created_at DESC, id DESC);

    DO $$ BEGIN
      CREATE ROLE iw_platform_admin NOLOGIN BYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE iw_platform_admin BYPASSRLS;
    END $$;
    GRANT iw_platform_admin TO CURRENT_USER;
    GRANT USAGE ON SCHEMA public TO iw_platform_admin;
    GRANT SELECT ON users, organizations, organization_members, refresh_sessions
      TO iw_platform_admin;
    GRANT UPDATE (status, platform_role, updated_at) ON users TO iw_platform_admin;
    GRANT UPDATE (revoked_at) ON refresh_sessions TO iw_platform_admin;
    GRANT INSERT ON audit_events TO iw_platform_admin;
    GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO iw_platform_admin;
  `);
}

export function down(): never {
  throw new Error('Platform administrator and session migration is forward-only.');
}
