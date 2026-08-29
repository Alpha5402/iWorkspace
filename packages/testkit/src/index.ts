import { type DeliveryDatabase } from '@delivery/database';

export function createEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...overrides,
  };
}

export async function createMemoryDatabase(): Promise<DeliveryDatabase> {
  const { DataType, newDb } = await import('pg-mem');
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({
    implementation: () => crypto.randomUUID(),
    impure: true,
    name: 'gen_random_uuid',
    returns: DataType.uuid,
  });
  memory.public.registerFunction({
    args: [DataType.text, DataType.text, DataType.bool],
    implementation: (_name: string, value: string) => value,
    name: 'set_config',
    returns: DataType.text,
  });
  memory.public.registerFunction({
    args: [DataType.text],
    implementation: (value: string) => value.trim(),
    name: 'trim',
    returns: DataType.text,
  });
  memory.public.registerFunction({
    args: [DataType.text, DataType.integer],
    implementation: (value: string) =>
      BigInt(`0x${Buffer.from(value).toString('hex').slice(0, 12) || '0'}`),
    name: 'hashtextextended',
    returns: DataType.bigint,
  });
  memory.public.registerFunction({
    args: [DataType.bigint],
    implementation: () => true,
    name: 'pg_advisory_xact_lock',
    returns: DataType.bool,
  });
  memory.public.none(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, email_canonical text GENERATED ALWAYS AS (lower(trim(email))) STORED UNIQUE, status text NOT NULL DEFAULT 'PENDING_VERIFICATION', platform_role text NOT NULL DEFAULT 'USER', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE user_password_credentials (user_id uuid PRIMARY KEY REFERENCES users(id), password_hash text NOT NULL, password_changed_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE email_verification_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz, superseded_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX email_verification_one_active_per_user ON email_verification_tokens(user_id) WHERE consumed_at IS NULL AND superseded_at IS NULL;
    CREATE TABLE identity_email_outbox (id uuid PRIMARY KEY, verification_token_id uuid NOT NULL REFERENCES email_verification_tokens(id), recipient_email text NOT NULL, message_type text NOT NULL, ciphertext text NOT NULL, encrypted_dek text NOT NULL, iv text NOT NULL, tag text NOT NULL, wrap_iv text NOT NULL, wrap_tag text NOT NULL, aad text NOT NULL, key_version integer NOT NULL, status text NOT NULL DEFAULT 'PENDING', available_at timestamptz NOT NULL DEFAULT now(), claimed_by text, claimed_until timestamptz, attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, provider_message_id text, last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
    CREATE TABLE public_rate_limits (dimension text NOT NULL, key_hash text NOT NULL, window_started_at timestamptz NOT NULL, hit_count integer NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY (dimension, key_hash, window_started_at));
    CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE organization_members (organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id, user_id));
    CREATE TABLE invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), email_canonical text NOT NULL, token_hash text NOT NULL UNIQUE, organization_role text NOT NULL, expires_at timestamptz NOT NULL, accepted_at timestamptz, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE refresh_sessions (id uuid PRIMARY KEY, family_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id), organization_id uuid NOT NULL REFERENCES organizations(id), token_jti uuid NOT NULL UNIQUE, signing_key_id text NOT NULL, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz, replaced_by uuid, ip_address text, user_agent text, last_seen_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, slug text NOT NULL, default_ruleset_version_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, slug));
    CREATE TABLE project_members (organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, user_id));
    CREATE TABLE project_api_tokens (id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), name text NOT NULL, token_prefix text NOT NULL, token_hash text NOT NULL UNIQUE, scopes text[] NOT NULL, expires_at timestamptz, revoked_at timestamptz, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
    CREATE VIEW platform_admin_user_token_metadata AS SELECT project_api_tokens.id, project_api_tokens.created_by, project_api_tokens.created_at, project_api_tokens.expires_at, project_api_tokens.name, project_api_tokens.project_id, projects.name AS project_name, project_api_tokens.revoked_at, project_api_tokens.scopes, project_api_tokens.token_prefix FROM project_api_tokens INNER JOIN projects ON projects.id = project_api_tokens.project_id;
    CREATE TABLE encrypted_secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), name text NOT NULL, ciphertext text NOT NULL, encrypted_dek text NOT NULL, iv text NOT NULL, tag text NOT NULL, wrap_iv text NOT NULL, wrap_tag text NOT NULL, aad text NOT NULL, key_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), rotated_at timestamptz, UNIQUE(project_id, name));
    CREATE TABLE secret_rotation_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, secret_id uuid NOT NULL REFERENCES encrypted_secrets(id), from_key_version integer NOT NULL, to_key_version integer NOT NULL, rotated_by uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE audit_events (id bigserial PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid, actor_type text NOT NULL CHECK (actor_type IN ('USER_SESSION', 'PROJECT_TOKEN', 'SYSTEM')), actor_id text NOT NULL, action text NOT NULL, target_type text NOT NULL, target_id text NOT NULL, trace_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE rulesets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), name text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, name));
    CREATE TABLE ruleset_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), ruleset_id uuid NOT NULL REFERENCES rulesets(id), version integer NOT NULL, status text NOT NULL, rules jsonb NOT NULL, content_hash text NOT NULL, published_at timestamptz, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(ruleset_id, version));
    CREATE UNIQUE INDEX ruleset_versions_one_draft_per_ruleset ON ruleset_versions(ruleset_id) WHERE status = 'DRAFT';
    CREATE TABLE repository_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), installation_id bigint NOT NULL, repository_id bigint NOT NULL, owner_login text NOT NULL, repository_name text NOT NULL, status text NOT NULL, permissions jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, repository_id));
    CREATE TABLE webhook_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, delivery_id text NOT NULL, event_name text NOT NULL, payload_hash text NOT NULL, status text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, error_code text, UNIQUE(provider, delivery_id));
    CREATE TABLE review_runs (id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), repository_connection_id uuid NOT NULL REFERENCES repository_connections(id), pull_request_number integer NOT NULL, base_sha text, head_sha text, diff_hash text, ruleset_version_id uuid NOT NULL REFERENCES ruleset_versions(id), model text NOT NULL, prompt_version text NOT NULL, status text NOT NULL, coverage_complete boolean NOT NULL, rerun_of_run_id uuid, request_idempotency_key text, version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz, UNIQUE(project_id, request_idempotency_key));
    CREATE TABLE run_events (id bigserial PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES review_runs(id), event_type text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES review_runs(id), task_type text NOT NULL, status text NOT NULL, available_at timestamptz NOT NULL, attempt_count integer NOT NULL, max_attempts integer NOT NULL, version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id, task_type));
    CREATE TABLE task_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id), attempt_number integer NOT NULL, worker_id text NOT NULL, fencing_token bigint NOT NULL, lease_expires_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL, status text NOT NULL, source_event_id uuid, error_code text, error_detail jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(task_id, attempt_number));
    CREATE TABLE outbox_events (id uuid PRIMARY KEY, event_type text NOT NULL, event_version integer NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL, correlation_id text NOT NULL, causation_id text, traceparent text, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, available_at timestamptz NOT NULL, claimed_until timestamptz, claimed_by text, publish_attempts integer NOT NULL, published_at timestamptz, last_error_code text);
    CREATE TABLE consumer_inbox (consumer_name text NOT NULL, event_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, result text, claimed_by text, claimed_until timestamptz, PRIMARY KEY(consumer_name, event_id));
    CREATE TABLE review_findings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES review_runs(id), batch_id uuid, rule_id text NOT NULL, category text NOT NULL, severity text NOT NULL, title text NOT NULL, description text NOT NULL, path text NOT NULL, start_line integer NOT NULL, end_line integer NOT NULL, side text NOT NULL, source text NOT NULL, confidence numeric NOT NULL, fingerprint text NOT NULL, verification_status text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id, fingerprint));
    CREATE TABLE artifacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid REFERENCES review_runs(id), artifact_type text NOT NULL, object_key text NOT NULL, content_hash text NOT NULL, size_bytes bigint NOT NULL, media_type text NOT NULL, retention_until timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id, artifact_type, content_hash));
    CREATE TABLE provider_invocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, provider text NOT NULL, model text NOT NULL, prompt_version text NOT NULL, schema_version text NOT NULL, input_hash text NOT NULL, provider_response_id text, status text NOT NULL, input_tokens integer, output_tokens integer, latency_ms integer, error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
    CREATE TABLE review_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, category text NOT NULL, sequence integer NOT NULL, input_hash text NOT NULL, estimated_tokens integer NOT NULL, status text NOT NULL, provider_invocation_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id, category, sequence));
    CREATE TABLE finding_verifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), finding_id uuid NOT NULL REFERENCES review_findings(id), method text NOT NULL, result text NOT NULL, rationale text NOT NULL, provider_invocation_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE evidence_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, evidence_type text NOT NULL, artifact_id uuid, source_hash text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE artifact_links (organization_id uuid NOT NULL, project_id uuid NOT NULL, parent_artifact_id uuid NOT NULL, child_artifact_id uuid NOT NULL, relation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(parent_artifact_id, child_artifact_id, relation));
    CREATE TABLE external_effects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, project_id uuid NOT NULL, run_id uuid NOT NULL, provider text NOT NULL, effect_type text NOT NULL, logical_key text NOT NULL, status text NOT NULL, provider_object_id text, request_hash text NOT NULL, attempt_count integer NOT NULL, last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider, effect_type, logical_key));
    CREATE TABLE provider_capacity_leases (provider text NOT NULL, slot integer NOT NULL, project_id uuid NOT NULL, attempt_id uuid NOT NULL, lease_expires_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL, PRIMARY KEY(provider, slot), UNIQUE(attempt_id));
  `);
  // pg-mem intentionally declares this adapter as any. The smoke query below verifies the Kysely contract.
  const database = memory.adapters.createKysely() as DeliveryDatabase;
  await database.selectFrom('users').select('id').execute();
  return database;
}
