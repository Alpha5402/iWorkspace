import { type MigrationBuilder } from 'node-pg-migrate';

export const shorthands = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE review_runs
      ALTER COLUMN base_sha DROP NOT NULL,
      ALTER COLUMN head_sha DROP NOT NULL,
      ALTER COLUMN diff_hash DROP NOT NULL;

    ALTER TABLE review_runs ADD CONSTRAINT review_runs_frozen_before_queue
      CHECK (
        status = 'ACCEPTED'
        OR (base_sha IS NOT NULL AND head_sha IS NOT NULL AND diff_hash IS NOT NULL)
      );

    ALTER TABLE review_runs ADD COLUMN request_idempotency_key text;
    CREATE UNIQUE INDEX review_runs_request_idempotency_idx
      ON review_runs(project_id, request_idempotency_key)
      WHERE request_idempotency_key IS NOT NULL;
  `);
}

export function down(): never {
  throw new Error('Review acceptance migration is forward-only.');
}
