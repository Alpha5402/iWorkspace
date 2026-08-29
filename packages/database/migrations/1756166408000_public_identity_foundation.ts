import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    DO $$ BEGIN
      CREATE TYPE platform_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
    UPDATE users SET status = 'SUSPENDED' WHERE status = 'DISABLED';
    ALTER TABLE users ALTER COLUMN status SET DEFAULT 'PENDING_VERIFICATION';
    ALTER TABLE users ADD CONSTRAINT users_status_check
      CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'));
    ALTER TABLE users ADD COLUMN platform_role platform_role NOT NULL DEFAULT 'USER';
    CREATE INDEX users_platform_role_status_idx ON users(platform_role, status, id);

    ALTER TABLE refresh_sessions ADD COLUMN token_jti uuid DEFAULT gen_random_uuid();
    ALTER TABLE refresh_sessions ADD COLUMN signing_key_id text DEFAULT 'legacy-opaque';

    -- The previous refresh credential was opaque and cannot satisfy the new signed JWT
    -- contract. Revoke it explicitly so the deployment performs a safe, visible re-login
    -- boundary instead of ambiguously accepting two credential formats.
    UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now());

    ALTER TABLE refresh_sessions ALTER COLUMN token_jti SET NOT NULL;
    ALTER TABLE refresh_sessions ALTER COLUMN token_jti DROP DEFAULT;
    ALTER TABLE refresh_sessions ALTER COLUMN signing_key_id SET NOT NULL;
    ALTER TABLE refresh_sessions ALTER COLUMN signing_key_id DROP DEFAULT;
    ALTER TABLE refresh_sessions ADD CONSTRAINT refresh_sessions_token_jti_unique UNIQUE (token_jti);
    ALTER TABLE refresh_sessions ADD CONSTRAINT refresh_sessions_signing_key_id_not_blank
      CHECK (length(btrim(signing_key_id)) > 0);
  `);
}

export function down(): never {
  throw new Error('Public identity foundation migration is forward-only.');
}
