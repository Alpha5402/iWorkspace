import { type MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_type_check;
    ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
    UPDATE audit_events
      SET
        actor_id = 'legacy-user:' || actor_id,
        actor_type = 'USER_SESSION',
        metadata = metadata || jsonb_build_object(
          'legacyPrincipalType', 'USER',
          'sessionIdentityUnavailable', true,
          'subjectUserId', actor_id
        )
      WHERE actor_type = 'USER';
    ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable;
    ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check
      CHECK (actor_type IN ('USER_SESSION', 'PROJECT_TOKEN', 'SYSTEM'));
  `);
}

export function down(): never {
  throw new Error('Principal identity migration is forward-only.');
}
