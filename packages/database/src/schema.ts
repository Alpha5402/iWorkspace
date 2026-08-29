import { type ColumnType, type Generated, type JSONColumnType } from 'kysely';

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type GeneratedId = Generated<string>;
export type JsonObject = JSONColumnType<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
>;
export type JsonArray = JSONColumnType<readonly unknown[]>;

export interface UsersTable {
  created_at: Generated<Timestamp>;
  email: string;
  email_canonical: Generated<string>;
  id: GeneratedId;
  platform_role: Generated<'SUPER_ADMIN' | 'ADMIN' | 'USER'>;
  status: Generated<'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED'>;
  updated_at: Timestamp;
}

export interface UserPasswordCredentialsTable {
  password_changed_at: Generated<Timestamp>;
  password_hash: string;
  user_id: string;
}

export interface EmailVerificationTokensTable {
  consumed_at: Timestamp | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  id: GeneratedId;
  superseded_at: Timestamp | null;
  token_hash: string;
  user_id: string;
}

export interface IdentityEmailOutboxTable {
  aad: string;
  attempt_count: Generated<number>;
  available_at: Timestamp;
  ciphertext: string;
  claimed_by: string | null;
  claimed_until: Timestamp | null;
  created_at: Timestamp;
  encrypted_dek: string;
  id: string;
  iv: string;
  key_version: number;
  last_error_code: string | null;
  max_attempts: Generated<number>;
  message_type: 'VERIFY_EMAIL';
  provider_message_id: string | null;
  recipient_email: string;
  sent_at: Timestamp | null;
  status: Generated<'PENDING' | 'CLAIMED' | 'RETRY_WAIT' | 'SENT' | 'FAILED'>;
  tag: string;
  verification_token_id: string;
  wrap_iv: string;
  wrap_tag: string;
}

export interface PublicRateLimitsTable {
  dimension: string;
  expires_at: Timestamp;
  hit_count: number;
  key_hash: string;
  window_started_at: Timestamp;
}

export interface OrganizationsTable {
  created_at: Generated<Timestamp>;
  id: GeneratedId;
  name: string;
}

export interface OrganizationMembersTable {
  created_at: Generated<Timestamp>;
  organization_id: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  user_id: string;
}

export interface ProjectsTable {
  created_at: Generated<Timestamp>;
  default_ruleset_version_id: string | null;
  id: GeneratedId;
  name: string;
  organization_id: string;
  slug: string;
}

export interface ProjectMembersTable {
  created_at: Generated<Timestamp>;
  organization_id: string;
  project_id: string;
  role: 'MAINTAINER' | 'REVIEWER' | 'VIEWER';
  user_id: string;
}

export interface InvitationsTable {
  accepted_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  created_by: string;
  email_canonical: string;
  expires_at: Timestamp;
  id: GeneratedId;
  organization_id: string;
  organization_role: 'OWNER' | 'ADMIN' | 'MEMBER';
  token_hash: string;
}

export interface RefreshSessionsTable {
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  family_id: string;
  id: GeneratedId;
  organization_id: string;
  replaced_by: string | null;
  revoked_at: Timestamp | null;
  signing_key_id: string;
  token_jti: string;
  token_hash: string;
  used_at: Timestamp | null;
  user_id: string;
}

export interface ProjectApiTokensTable {
  created_at: Generated<Timestamp>;
  created_by: string;
  expires_at: Timestamp | null;
  id: GeneratedId;
  name: string;
  organization_id: string;
  project_id: string;
  revoked_at: Timestamp | null;
  scopes: string[];
  token_hash: string;
  token_prefix: string;
}

export interface RulesetsTable {
  created_at: Generated<Timestamp>;
  created_by: string;
  id: GeneratedId;
  name: string;
  organization_id: string;
  project_id: string;
}

export interface RulesetVersionsTable {
  content_hash: string;
  created_at: Generated<Timestamp>;
  created_by: string;
  id: GeneratedId;
  organization_id: string;
  project_id: string;
  published_at: Timestamp | null;
  rules: JsonArray;
  ruleset_id: string;
  status: 'DRAFT' | 'PUBLISHED';
  version: number;
}

export interface RepositoryConnectionsTable {
  created_at: Generated<Timestamp>;
  id: GeneratedId;
  installation_id: string;
  organization_id: string;
  owner_login: string;
  permissions: JsonObject;
  project_id: string;
  repository_id: string;
  repository_name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
}

export interface ReviewRunsTable {
  base_sha: string | null;
  completed_at: Timestamp | null;
  coverage_complete: boolean;
  created_at: Generated<Timestamp>;
  diff_hash: string | null;
  head_sha: string | null;
  id: GeneratedId;
  model: string;
  organization_id: string;
  project_id: string;
  prompt_version: string;
  pull_request_number: number;
  repository_connection_id: string;
  request_idempotency_key: string | null;
  rerun_of_run_id: string | null;
  ruleset_version_id: string;
  started_at: Timestamp | null;
  status:
    'ACCEPTED' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'STALE';
  version: number;
}

export interface RunEventsTable {
  event_type: string;
  id: Generated<number>;
  occurred_at: Generated<Timestamp>;
  organization_id: string;
  payload: JsonObject;
  project_id: string;
  run_id: string;
}

export interface TasksTable {
  attempt_count: number;
  available_at: Timestamp;
  created_at: Generated<Timestamp>;
  id: GeneratedId;
  max_attempts: number;
  organization_id: string;
  project_id: string;
  run_id: string;
  status: 'PENDING' | 'LEASED' | 'SUCCEEDED' | 'RETRY_WAIT' | 'FAILED' | 'CANCELLED';
  task_type: string;
  version: number;
}

export interface TaskAttemptsTable {
  attempt_number: number;
  completed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  error_code: string | null;
  error_detail: JsonObject | null;
  fencing_token: string;
  heartbeat_at: Timestamp;
  id: GeneratedId;
  lease_expires_at: Timestamp;
  organization_id: string;
  project_id: string;
  status:
    'LEASED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'LEASE_EXPIRED' | 'ABANDONED';
  source_event_id: string | null;
  task_id: string;
  worker_id: string;
}

export interface OutboxEventsTable {
  available_at: Timestamp;
  causation_id: string | null;
  claimed_by: string | null;
  claimed_until: Timestamp | null;
  correlation_id: string;
  event_type: string;
  event_version: number;
  id: string;
  last_error_code: string | null;
  occurred_at: Timestamp;
  organization_id: string;
  payload: JsonObject;
  project_id: string;
  publish_attempts: number;
  published_at: Timestamp | null;
  traceparent: string | null;
}

export interface ConsumerInboxTable {
  claimed_by: string | null;
  claimed_until: Timestamp | null;
  completed_at: Timestamp | null;
  consumer_name: string;
  event_id: string;
  received_at: Generated<Timestamp>;
  result: string | null;
}

export interface AuditEventsTable {
  action: string;
  actor_id: string;
  actor_type: 'USER' | 'PROJECT_TOKEN' | 'SYSTEM';
  id: Generated<number>;
  metadata: JsonObject;
  occurred_at: Generated<Timestamp>;
  organization_id: string;
  project_id: string | null;
  target_id: string;
  target_type: string;
  trace_id: string;
}

export interface EncryptedSecretsTable {
  aad: string;
  ciphertext: string;
  created_at: Generated<Timestamp>;
  encrypted_dek: string;
  id: GeneratedId;
  iv: string;
  key_version: number;
  name: string;
  organization_id: string;
  project_id: string;
  rotated_at: Timestamp | null;
  tag: string;
  wrap_iv: string;
  wrap_tag: string;
}

export interface SecretRotationEventsTable {
  created_at: Generated<Timestamp>;
  from_key_version: number;
  id: GeneratedId;
  organization_id: string;
  project_id: string;
  rotated_by: string | null;
  secret_id: string;
  to_key_version: number;
}

export interface WebhookDeliveriesTable {
  delivery_id: string;
  error_code: string | null;
  event_name: string;
  id: GeneratedId;
  payload_hash: string;
  processed_at: Timestamp | null;
  provider: string;
  received_at: Generated<Timestamp>;
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
}

export interface ReviewFindingsTable {
  batch_id: string | null;
  category: 'DESIGN' | 'IMPLEMENTATION' | 'DEFECT';
  confidence: number | string;
  created_at: Generated<Timestamp>;
  description: string;
  end_line: number;
  evidence: JsonArray;
  fingerprint: string;
  id: GeneratedId;
  organization_id: string;
  path: string;
  project_id: string;
  rule_id: string;
  run_id: string;
  severity: 'BLOCKING' | 'MAJOR' | 'MINOR' | 'INFO';
  side: 'LEFT' | 'RIGHT';
  source: 'DETERMINISTIC' | 'MODEL';
  start_line: number;
  title: string;
  verification_status: 'CONFIRMED' | 'DISPUTED' | 'REJECTED' | 'NEEDS_HUMAN';
}

export interface IdempotencyRecordsTable {
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  idempotency_key: string;
  request_hash: string;
  response_body: JsonObject | null;
  response_status: number | null;
  scope: string;
}

export interface ArtifactsTable {
  artifact_type: string;
  content_hash: string;
  created_at: Generated<Timestamp>;
  id: GeneratedId;
  media_type: string;
  object_key: string;
  organization_id: string;
  project_id: string;
  retention_until: Timestamp;
  run_id: string | null;
  size_bytes: string;
}

export interface ArtifactLinksTable {
  child_artifact_id: string;
  created_at: Generated<Timestamp>;
  parent_artifact_id: string;
  organization_id: string;
  project_id: string;
  relation: string;
}

export interface EvidenceRecordsTable {
  artifact_id: string | null;
  created_at: Generated<Timestamp>;
  evidence_type: string;
  id: GeneratedId;
  metadata: JsonObject;
  organization_id: string;
  project_id: string;
  run_id: string;
  source_hash: string;
}

export interface ReviewBatchesTable {
  category: 'DESIGN' | 'IMPLEMENTATION' | 'DEFECT';
  created_at: Generated<Timestamp>;
  estimated_tokens: number;
  id: GeneratedId;
  input_hash: string;
  organization_id: string;
  project_id: string;
  provider_invocation_id: string | null;
  run_id: string;
  sequence: number;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
}

export interface ProviderInvocationsTable {
  completed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  error_code: string | null;
  id: GeneratedId;
  input_hash: string;
  input_tokens: number | null;
  latency_ms: number | null;
  model: string;
  organization_id: string;
  output_tokens: number | null;
  project_id: string;
  prompt_version: string;
  provider: string;
  provider_response_id: string | null;
  run_id: string;
  schema_version: string;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
}

export interface ExternalEffectsTable {
  attempt_count: number;
  created_at: Generated<Timestamp>;
  effect_type: string;
  id: GeneratedId;
  last_error_code: string | null;
  logical_key: string;
  organization_id: string;
  project_id: string;
  provider: string;
  provider_object_id: string | null;
  request_hash: string;
  run_id: string;
  status: 'PREPARED' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  updated_at: Timestamp;
}

export interface FindingVerificationsTable {
  created_at: Generated<Timestamp>;
  finding_id: string;
  id: GeneratedId;
  method: 'DETERMINISTIC' | 'MODEL';
  provider_invocation_id: string | null;
  rationale: string;
  result: 'CONFIRMED' | 'DISPUTED' | 'REJECTED' | 'NEEDS_HUMAN';
}

export interface ProviderCapacityLeasesTable {
  attempt_id: string;
  heartbeat_at: Timestamp;
  lease_expires_at: Timestamp;
  project_id: string;
  provider: string;
  slot: number;
}

export interface DatabaseSchema {
  artifact_links: ArtifactLinksTable;
  artifacts: ArtifactsTable;
  audit_events: AuditEventsTable;
  consumer_inbox: ConsumerInboxTable;
  encrypted_secrets: EncryptedSecretsTable;
  email_verification_tokens: EmailVerificationTokensTable;
  evidence_records: EvidenceRecordsTable;
  external_effects: ExternalEffectsTable;
  finding_verifications: FindingVerificationsTable;
  idempotency_records: IdempotencyRecordsTable;
  identity_email_outbox: IdentityEmailOutboxTable;
  invitations: InvitationsTable;
  organization_members: OrganizationMembersTable;
  organizations: OrganizationsTable;
  outbox_events: OutboxEventsTable;
  project_api_tokens: ProjectApiTokensTable;
  project_members: ProjectMembersTable;
  projects: ProjectsTable;
  provider_invocations: ProviderInvocationsTable;
  provider_capacity_leases: ProviderCapacityLeasesTable;
  public_rate_limits: PublicRateLimitsTable;
  refresh_sessions: RefreshSessionsTable;
  repository_connections: RepositoryConnectionsTable;
  review_batches: ReviewBatchesTable;
  review_findings: ReviewFindingsTable;
  review_runs: ReviewRunsTable;
  ruleset_versions: RulesetVersionsTable;
  rulesets: RulesetsTable;
  run_events: RunEventsTable;
  secret_rotation_events: SecretRotationEventsTable;
  task_attempts: TaskAttemptsTable;
  tasks: TasksTable;
  user_password_credentials: UserPasswordCredentialsTable;
  users: UsersTable;
  webhook_deliveries: WebhookDeliveriesTable;
}
