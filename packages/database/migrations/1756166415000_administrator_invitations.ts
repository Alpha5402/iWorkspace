import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE administrator_invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
      email_canonical text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
      target_role platform_role NOT NULL DEFAULT 'ADMIN' CHECK (target_role = 'ADMIN'),
      token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
      idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
      request_hash text NOT NULL CHECK (length(request_hash) = 64),
      created_by uuid NOT NULL REFERENCES users(id),
      accepted_user_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      revoked_at timestamptz,
      CHECK (expires_at > created_at),
      CHECK (
        (status = 'PENDING' AND consumed_at IS NULL AND revoked_at IS NULL AND accepted_user_id IS NULL)
        OR (status = 'ACCEPTED' AND consumed_at IS NOT NULL AND revoked_at IS NULL AND accepted_user_id IS NOT NULL)
        OR (status = 'REVOKED' AND consumed_at IS NULL AND revoked_at IS NOT NULL AND accepted_user_id IS NULL)
        OR (status = 'EXPIRED' AND consumed_at IS NULL AND revoked_at IS NULL AND accepted_user_id IS NULL)
      ),
      UNIQUE (created_by, idempotency_key)
    );
    CREATE UNIQUE INDEX administrator_invitations_one_pending_email
      ON administrator_invitations(email_canonical)
      WHERE status = 'PENDING';
    CREATE INDEX administrator_invitations_created_id_idx
      ON administrator_invitations(created_at DESC, id DESC);

    ALTER TABLE identity_email_outbox
      ALTER COLUMN verification_token_id DROP NOT NULL;
    ALTER TABLE identity_email_outbox
      ADD COLUMN administrator_invitation_id uuid
        REFERENCES administrator_invitations(id) ON DELETE CASCADE;
    ALTER TABLE identity_email_outbox
      DROP CONSTRAINT IF EXISTS identity_email_outbox_message_type_check;
    ALTER TABLE identity_email_outbox
      ADD CONSTRAINT identity_email_outbox_message_type_check
        CHECK (message_type IN ('VERIFY_EMAIL', 'ADMINISTRATOR_INVITATION'));
    ALTER TABLE identity_email_outbox
      ADD CONSTRAINT identity_email_outbox_exactly_one_identity_target
        CHECK (num_nonnulls(verification_token_id, administrator_invitation_id) = 1);
    ALTER TABLE identity_email_outbox
      ADD CONSTRAINT identity_email_outbox_message_target_matches
        CHECK (
          (message_type = 'VERIFY_EMAIL' AND verification_token_id IS NOT NULL)
          OR (message_type = 'ADMINISTRATOR_INVITATION' AND administrator_invitation_id IS NOT NULL)
        );
    CREATE INDEX identity_email_outbox_administrator_invitation_idx
      ON identity_email_outbox(administrator_invitation_id, created_at DESC)
      WHERE administrator_invitation_id IS NOT NULL;

    GRANT SELECT, INSERT, UPDATE ON administrator_invitations TO iw_api;
    GRANT SELECT ON administrator_invitations TO iw_worker;
    GRANT SELECT (
      id, email, email_canonical, target_role, status, idempotency_key, request_hash,
      created_by, accepted_user_id, created_at, updated_at, expires_at, consumed_at, revoked_at
    ) ON administrator_invitations TO iw_platform_admin;
    GRANT INSERT ON administrator_invitations TO iw_platform_admin;
    GRANT UPDATE (
      accepted_user_id, consumed_at, expires_at, revoked_at, status, token_hash, updated_at
    ) ON administrator_invitations TO iw_platform_admin;
    GRANT INSERT ON identity_email_outbox TO iw_platform_admin;
    GRANT SELECT (
      administrator_invitation_id, status, last_error_code, created_at, sent_at
    ) ON identity_email_outbox TO iw_platform_admin;
    GRANT UPDATE (status, last_error_code) ON identity_email_outbox TO iw_platform_admin;
  `);
}

export function down(): never {
  throw new Error('Administrator invitation migration is forward-only.');
}
