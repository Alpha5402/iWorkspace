import { type MigrationBuilder } from 'node-pg-migrate';

export const shorthands = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    DO $$ BEGIN CREATE TYPE organization_role AS ENUM ('OWNER', 'ADMIN', 'MEMBER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE project_role AS ENUM ('MAINTAINER', 'REVIEWER', 'VIEWER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE run_status AS ENUM ('ACCEPTED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'STALE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE task_status AS ENUM ('PENDING', 'LEASED', 'SUCCEEDED', 'RETRY_WAIT', 'FAILED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE effect_status AS ENUM ('PREPARED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE finding_severity AS ENUM ('BLOCKING', 'MAJOR', 'MINOR', 'INFO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE finding_verification AS ENUM ('CONFIRMED', 'DISPUTED', 'REJECTED', 'NEEDS_HUMAN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      email_canonical text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (email_canonical)
    );

    CREATE TABLE user_password_credentials (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash text NOT NULL,
      password_changed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE organization_members (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role organization_role NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, user_id)
    );

    CREATE TABLE invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email_canonical text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      organization_role organization_role NOT NULL DEFAULT 'MEMBER',
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (expires_at > created_at)
    );

    CREATE TABLE refresh_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id uuid NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      revoked_at timestamptz,
      replaced_by uuid REFERENCES refresh_sessions(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (expires_at > created_at)
    );
    CREATE INDEX refresh_sessions_family_idx ON refresh_sessions(family_id);

    CREATE TABLE projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
      slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
      default_ruleset_version_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, slug),
      UNIQUE (organization_id, id)
    );

    CREATE TABLE project_members (
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role project_role NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE
    );

    CREATE TABLE project_api_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
      token_prefix text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      scopes text[] NOT NULL CHECK (scopes <@ ARRAY['review:trigger','review:read','project:read','artifact:read']::text[]),
      expires_at timestamptz,
      revoked_at timestamptz,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE encrypted_secrets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      name text NOT NULL,
      ciphertext text NOT NULL,
      encrypted_dek text NOT NULL,
      iv text NOT NULL,
      tag text NOT NULL,
      wrap_iv text NOT NULL,
      wrap_tag text NOT NULL,
      aad text NOT NULL,
      key_version integer NOT NULL CHECK (key_version > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      rotated_at timestamptz,
      UNIQUE (project_id, name),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE secret_rotation_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      secret_id uuid NOT NULL REFERENCES encrypted_secrets(id) ON DELETE CASCADE,
      from_key_version integer NOT NULL,
      to_key_version integer NOT NULL,
      rotated_by uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (to_key_version > from_key_version),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      project_id uuid,
      actor_type text NOT NULL CHECK (actor_type IN ('USER', 'PROJECT_TOKEN', 'SYSTEM')),
      actor_id text NOT NULL,
      action text NOT NULL,
      target_type text NOT NULL,
      target_id text NOT NULL,
      trace_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT
    );

    CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit_events are append-only'; END $$;
    CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

    CREATE TABLE rulesets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      name text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, name),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE ruleset_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      ruleset_id uuid NOT NULL REFERENCES rulesets(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0),
      status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
      rules jsonb NOT NULL,
      content_hash text NOT NULL,
      published_at timestamptz,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (ruleset_id, version),
      UNIQUE (project_id, id),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
      CHECK ((status = 'DRAFT' AND published_at IS NULL) OR (status = 'PUBLISHED' AND published_at IS NOT NULL))
    );
    ALTER TABLE projects ADD CONSTRAINT projects_default_ruleset_fk
      FOREIGN KEY (id, default_ruleset_version_id)
      REFERENCES ruleset_versions(project_id, id);

    CREATE FUNCTION reject_published_ruleset_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status = 'PUBLISHED' THEN RAISE EXCEPTION 'published ruleset versions are immutable'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ruleset_versions_immutable BEFORE UPDATE ON ruleset_versions
      FOR EACH ROW EXECUTE FUNCTION reject_published_ruleset_mutation();

    CREATE TABLE repository_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      installation_id bigint NOT NULL,
      repository_id bigint NOT NULL,
      owner_login text NOT NULL,
      repository_name text NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
      permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, repository_id),
      UNIQUE (project_id, id),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      delivery_id text NOT NULL,
      event_name text NOT NULL,
      payload_hash text NOT NULL,
      status text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
      received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      error_code text,
      UNIQUE (provider, delivery_id)
    );

    CREATE TABLE review_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      repository_connection_id uuid NOT NULL,
      pull_request_number integer NOT NULL CHECK (pull_request_number > 0),
      base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
      head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
      diff_hash text NOT NULL,
      ruleset_version_id uuid NOT NULL,
      model text NOT NULL,
      prompt_version text NOT NULL,
      status run_status NOT NULL DEFAULT 'ACCEPTED',
      coverage_complete boolean NOT NULL DEFAULT false,
      rerun_of_run_id uuid REFERENCES review_runs(id),
      version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      UNIQUE (project_id, id),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, repository_connection_id) REFERENCES repository_connections(project_id, id),
      FOREIGN KEY (project_id, ruleset_version_id) REFERENCES ruleset_versions(project_id, id)
    );
    CREATE UNIQUE INDEX review_runs_automatic_identity_idx
      ON review_runs(repository_connection_id, pull_request_number, head_sha, ruleset_version_id)
      WHERE rerun_of_run_id IS NULL;

    CREATE TABLE run_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX run_events_run_id_id_idx ON run_events(run_id, id);

    CREATE TABLE tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid NOT NULL,
      task_type text NOT NULL,
      status task_status NOT NULL DEFAULT 'PENDING',
      available_at timestamptz NOT NULL DEFAULT now(),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
      version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, task_type),
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE task_dependencies (
      task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id)
    );

    CREATE TABLE task_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      task_id uuid NOT NULL,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      worker_id text NOT NULL,
      fencing_token bigint NOT NULL CHECK (fencing_token > 0),
      lease_expires_at timestamptz NOT NULL,
      heartbeat_at timestamptz NOT NULL,
      status text NOT NULL CHECK (status IN ('LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'LEASE_EXPIRED', 'ABANDONED')),
      error_code text,
      error_detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      UNIQUE (task_id, attempt_number),
      UNIQUE (task_id, fencing_token),
      FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX one_active_task_lease ON task_attempts(task_id)
      WHERE status IN ('LEASED', 'RUNNING');

    CREATE TABLE outbox_events (
      id uuid PRIMARY KEY,
      event_type text NOT NULL,
      event_version integer NOT NULL DEFAULT 1,
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      correlation_id text NOT NULL,
      causation_id text,
      traceparent text,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL,
      available_at timestamptz NOT NULL DEFAULT now(),
      claimed_until timestamptz,
      claimed_by text,
      publish_attempts integer NOT NULL DEFAULT 0,
      published_at timestamptz,
      last_error_code text
    );
    CREATE INDEX outbox_unpublished_idx ON outbox_events(available_at, occurred_at) WHERE published_at IS NULL;

    CREATE TABLE consumer_inbox (
      consumer_name text NOT NULL,
      event_id uuid NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      result text,
      PRIMARY KEY (consumer_name, event_id)
    );

    CREATE TABLE idempotency_records (
      scope text NOT NULL,
      idempotency_key text NOT NULL,
      request_hash text NOT NULL,
      response_status integer,
      response_body jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (scope, idempotency_key)
    );

    CREATE TABLE artifacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid,
      artifact_type text NOT NULL,
      object_key text NOT NULL UNIQUE,
      content_hash text NOT NULL,
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      media_type text NOT NULL,
      retention_until timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, id),
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE evidence_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid NOT NULL,
      evidence_type text NOT NULL,
      artifact_id uuid,
      source_hash text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts(project_id, id),
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE review_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid NOT NULL,
      category text NOT NULL CHECK (category IN ('DESIGN', 'IMPLEMENTATION', 'DEFECT')),
      sequence integer NOT NULL CHECK (sequence >= 0),
      input_hash text NOT NULL,
      estimated_tokens integer NOT NULL CHECK (estimated_tokens >= 0),
      status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, category, sequence),
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE review_findings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid NOT NULL,
      batch_id uuid REFERENCES review_batches(id) ON DELETE SET NULL,
      rule_id text NOT NULL,
      category text NOT NULL CHECK (category IN ('DESIGN', 'IMPLEMENTATION', 'DEFECT')),
      severity finding_severity NOT NULL,
      title text NOT NULL,
      description text NOT NULL,
      path text NOT NULL,
      start_line integer NOT NULL CHECK (start_line > 0),
      end_line integer NOT NULL CHECK (end_line >= start_line),
      side text NOT NULL DEFAULT 'RIGHT' CHECK (side IN ('LEFT', 'RIGHT')),
      source text NOT NULL CHECK (source IN ('DETERMINISTIC', 'MODEL')),
      confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      fingerprint text NOT NULL,
      verification_status finding_verification NOT NULL,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (run_id, fingerprint),
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE finding_verifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      finding_id uuid NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,
      method text NOT NULL CHECK (method IN ('DETERMINISTIC', 'MODEL')),
      result finding_verification NOT NULL,
      rationale text NOT NULL,
      provider_invocation_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE provider_invocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      prompt_version text NOT NULL,
      schema_version text NOT NULL,
      input_hash text NOT NULL,
      provider_response_id text,
      status text NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
      input_tokens integer,
      output_tokens integer,
      latency_ms integer,
      error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );
    ALTER TABLE finding_verifications ADD CONSTRAINT finding_verification_invocation_fk
      FOREIGN KEY (provider_invocation_id) REFERENCES provider_invocations(id);

    CREATE TABLE external_effects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      project_id uuid NOT NULL,
      run_id uuid NOT NULL,
      provider text NOT NULL,
      effect_type text NOT NULL,
      logical_key text NOT NULL,
      status effect_status NOT NULL DEFAULT 'PREPARED',
      provider_object_id text,
      request_hash text NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0,
      last_error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, effect_type, logical_key),
      FOREIGN KEY (project_id, run_id) REFERENCES review_runs(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
    );

    CREATE TABLE provider_capacity_leases (
      provider text NOT NULL,
      slot integer NOT NULL CHECK (slot >= 0),
      project_id uuid NOT NULL,
      attempt_id uuid NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
      lease_expires_at timestamptz NOT NULL,
      heartbeat_at timestamptz NOT NULL,
      PRIMARY KEY (provider, slot),
      UNIQUE (attempt_id)
    );

    DO $$ BEGIN CREATE ROLE iw_api NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE iw_worker NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT iw_api, iw_worker TO CURRENT_USER;
    GRANT USAGE ON SCHEMA public TO iw_api, iw_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO iw_api, iw_worker;
    REVOKE DELETE ON ruleset_versions FROM iw_api, iw_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iw_api, iw_worker;

    CREATE FUNCTION current_tenant_organization_id() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('app.organization_id', true), '')::uuid
    $$;

    DO $$
    DECLARE table_name text;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'organization_members','invitations','refresh_sessions','projects','project_members',
        'project_api_tokens','encrypted_secrets','secret_rotation_events','audit_events','rulesets','ruleset_versions',
        'repository_connections','review_runs','run_events','tasks','task_attempts','artifacts','evidence_records',
        'review_batches','review_findings','provider_invocations','external_effects'
      ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_tenant_organization_id()) WITH CHECK (organization_id = current_tenant_organization_id())',
          table_name
        );
      END LOOP;
    END $$;
    ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON organizations
      USING (id = current_tenant_organization_id())
      WITH CHECK (id = current_tenant_organization_id());
  `);
}

export function down(): never {
  throw new Error('M1 foundation is forward-only; create a corrective migration instead.');
}
