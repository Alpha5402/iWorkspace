import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE email_verification_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (expires_at > created_at),
      CHECK (consumed_at IS NULL OR superseded_at IS NULL)
    );
    CREATE UNIQUE INDEX email_verification_one_active_per_user
      ON email_verification_tokens(user_id)
      WHERE consumed_at IS NULL AND superseded_at IS NULL;

    CREATE TABLE identity_email_outbox (
      id uuid PRIMARY KEY,
      verification_token_id uuid NOT NULL REFERENCES email_verification_tokens(id) ON DELETE CASCADE,
      recipient_email text NOT NULL,
      message_type text NOT NULL CHECK (message_type IN ('VERIFY_EMAIL')),
      ciphertext text NOT NULL,
      encrypted_dek text NOT NULL,
      iv text NOT NULL,
      tag text NOT NULL,
      wrap_iv text NOT NULL,
      wrap_tag text NOT NULL,
      aad text NOT NULL,
      key_version integer NOT NULL CHECK (key_version > 0),
      status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'CLAIMED', 'RETRY_WAIT', 'SENT', 'FAILED')),
      available_at timestamptz NOT NULL DEFAULT now(),
      claimed_by text,
      claimed_until timestamptz,
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
      provider_message_id text,
      last_error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz,
      CHECK (
        (status = 'CLAIMED' AND claimed_by IS NOT NULL AND claimed_until IS NOT NULL)
        OR (status <> 'CLAIMED' AND claimed_by IS NULL AND claimed_until IS NULL)
      ),
      CHECK ((status = 'SENT' AND sent_at IS NOT NULL) OR (status <> 'SENT' AND sent_at IS NULL))
    );
    CREATE INDEX identity_email_outbox_available_idx
      ON identity_email_outbox(available_at, created_at)
      WHERE status IN ('PENDING', 'RETRY_WAIT', 'CLAIMED');
    CREATE INDEX identity_email_outbox_claim_expiry_idx
      ON identity_email_outbox(claimed_until)
      WHERE status = 'CLAIMED';

    CREATE TABLE public_rate_limits (
      dimension text NOT NULL,
      key_hash text NOT NULL,
      window_started_at timestamptz NOT NULL,
      hit_count integer NOT NULL CHECK (hit_count > 0),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (dimension, key_hash, window_started_at),
      CHECK (expires_at > window_started_at)
    );
    CREATE INDEX public_rate_limits_expiry_idx ON public_rate_limits(expires_at);

    GRANT SELECT, INSERT, UPDATE ON email_verification_tokens TO iw_api;
    GRANT SELECT ON email_verification_tokens TO iw_worker;
    GRANT SELECT, INSERT, UPDATE ON identity_email_outbox TO iw_api;
    GRANT SELECT, UPDATE ON identity_email_outbox TO iw_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public_rate_limits TO iw_api;
  `);
}

export function down(): never {
  throw new Error('Public registration migration is forward-only.');
}
