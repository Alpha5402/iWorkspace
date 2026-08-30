import { createHash } from 'node:crypto';

import { type DeliveryDatabase, withTenant } from '@delivery/database';

import {
  type M1ProofBundleRepository,
  type M1ProofBundleSnapshot,
  type ProofExecutionRecord,
} from './m1ProofBundle.js';

export function createPostgresM1ProofBundleRepository(
  database: DeliveryDatabase,
): M1ProofBundleRepository {
  return {
    async load(organizationId, runId) {
      return withTenant(database, organizationId, async (transaction) => {
        const run = await transaction
          .selectFrom('review_runs')
          .innerJoin(
            'repository_connections',
            'repository_connections.id',
            'review_runs.repository_connection_id',
          )
          .innerJoin('ruleset_versions', 'ruleset_versions.id', 'review_runs.ruleset_version_id')
          .select([
            'review_runs.base_sha as baseSha',
            'review_runs.completed_at as completedAt',
            'review_runs.coverage_complete as coverageComplete',
            'review_runs.diff_hash as diffHash',
            'review_runs.head_sha as headSha',
            'review_runs.id',
            'review_runs.model',
            'review_runs.organization_id as organizationId',
            'review_runs.project_id as projectId',
            'review_runs.prompt_version as promptVersion',
            'review_runs.pull_request_number as pullRequestNumber',
            'review_runs.started_at as startedAt',
            'review_runs.status',
            'repository_connections.repository_id as repositoryId',
            'repository_connections.repository_name as repositoryName',
            'repository_connections.owner_login as repositoryOwner',
            'ruleset_versions.content_hash as rulesetContentHash',
            'ruleset_versions.id as rulesetVersionId',
            'ruleset_versions.published_at as rulesetPublishedAt',
            'ruleset_versions.status as rulesetStatus',
            'ruleset_versions.version as rulesetVersion',
          ])
          .where('review_runs.id', '=', runId)
          .where('review_runs.organization_id', '=', organizationId)
          .executeTakeFirst();
        if (run === undefined) throw new Error('PROOF_REVIEW_RUN_NOT_FOUND');

        const [
          artifacts,
          evidenceRecords,
          artifactLinks,
          tasks,
          attempts,
          batches,
          providerInvocations,
          externalEffects,
          findings,
          findingVerifications,
          runEvents,
        ] = await Promise.all([
          transaction
            .selectFrom('artifacts')
            .select([
              'artifact_type as artifactType',
              'content_hash as contentHash',
              'id',
              'media_type as mediaType',
              'object_key as objectKey',
              'size_bytes as sizeBytes',
            ])
            .where('run_id', '=', runId)
            .orderBy('artifact_type', 'asc')
            .orderBy('id', 'asc')
            .execute(),
          transaction
            .selectFrom('evidence_records')
            .select([
              'artifact_id as artifactId',
              'evidence_type as evidenceType',
              'id',
              'metadata',
              'source_hash as sourceHash',
            ])
            .where('run_id', '=', runId)
            .orderBy('created_at', 'asc')
            .orderBy('id', 'asc')
            .execute(),
          transaction
            .selectFrom('artifact_links')
            .innerJoin('artifacts as child', 'child.id', 'artifact_links.child_artifact_id')
            .select([
              'artifact_links.child_artifact_id as childArtifactId',
              'artifact_links.parent_artifact_id as parentArtifactId',
              'artifact_links.relation',
            ])
            .where('child.run_id', '=', runId)
            .orderBy('artifact_links.created_at', 'asc')
            .execute(),
          transaction
            .selectFrom('tasks')
            .selectAll()
            .where('run_id', '=', runId)
            .orderBy('created_at', 'asc')
            .orderBy('id', 'asc')
            .execute(),
          transaction
            .selectFrom('task_attempts')
            .innerJoin('tasks', 'tasks.id', 'task_attempts.task_id')
            .select([
              'task_attempts.attempt_number as attemptNumber',
              'task_attempts.completed_at as completedAt',
              'task_attempts.created_at as createdAt',
              'task_attempts.error_code as errorCode',
              'task_attempts.fencing_token as fencingToken',
              'task_attempts.id',
              'task_attempts.source_event_id as sourceEventId',
              'task_attempts.status',
              'task_attempts.task_id as taskId',
              'task_attempts.worker_id as workerId',
            ])
            .where('tasks.run_id', '=', runId)
            .orderBy('task_attempts.created_at', 'asc')
            .orderBy('task_attempts.id', 'asc')
            .execute(),
          transaction
            .selectFrom('review_batches')
            .selectAll()
            .where('run_id', '=', runId)
            .orderBy('category', 'asc')
            .orderBy('sequence', 'asc')
            .execute(),
          transaction
            .selectFrom('provider_invocations')
            .selectAll()
            .where('run_id', '=', runId)
            .orderBy('created_at', 'asc')
            .orderBy('id', 'asc')
            .execute(),
          transaction
            .selectFrom('external_effects')
            .selectAll()
            .where('run_id', '=', runId)
            .orderBy('created_at', 'asc')
            .orderBy('id', 'asc')
            .execute(),
          transaction
            .selectFrom('review_findings')
            .selectAll()
            .where('run_id', '=', runId)
            .orderBy('severity', 'asc')
            .orderBy('fingerprint', 'asc')
            .execute(),
          transaction
            .selectFrom('finding_verifications')
            .innerJoin('review_findings', 'review_findings.id', 'finding_verifications.finding_id')
            .select([
              'finding_verifications.finding_id as findingId',
              'finding_verifications.id',
              'finding_verifications.method',
              'finding_verifications.provider_invocation_id as providerInvocationId',
              'finding_verifications.rationale',
              'finding_verifications.result',
            ])
            .where('review_findings.run_id', '=', runId)
            .orderBy('finding_verifications.created_at', 'asc')
            .orderBy('finding_verifications.id', 'asc')
            .execute(),
          transaction
            .selectFrom('run_events')
            .selectAll()
            .where('run_id', '=', runId)
            .orderBy('id', 'asc')
            .execute(),
        ]);

        return {
          artifacts: artifacts.map((artifact) => ({
            ...artifact,
            sizeBytes: parseSize(artifact.id, artifact.sizeBytes),
          })),
          evidence: {
            links: artifactLinks,
            records: evidenceRecords,
          },
          execution: {
            attempts: attempts.map((attempt) =>
              record(attempt.id, 'TASK_ATTEMPT', attempt.status, {
                attemptNumber: attempt.attemptNumber,
                completedAt: iso(attempt.completedAt),
                createdAt: requiredIso(attempt.createdAt),
                errorCode: attempt.errorCode,
                fencingToken: normalizeIntegerLike(
                  attempt.fencingToken,
                  'PROOF_FENCING_TOKEN_INVALID',
                ),
                sourceEventId: attempt.sourceEventId,
                taskId: attempt.taskId,
                workerIdHash: hashWorkerId(attempt.workerId),
              }),
            ),
            batches: batches.map((batch) =>
              record(batch.id, batch.category, batch.status, {
                estimatedTokens: batch.estimated_tokens,
                inputHash: batch.input_hash,
                providerInvocationId: batch.provider_invocation_id,
                sequence: batch.sequence,
              }),
            ),
            externalEffects: externalEffects.map((effect) =>
              record(effect.id, effect.effect_type, effect.status, {
                attemptCount: effect.attempt_count,
                lastErrorCode: effect.last_error_code,
                logicalKey: effect.logical_key,
                provider: effect.provider,
                providerObjectId: effect.provider_object_id,
                requestHash: effect.request_hash,
              }),
            ),
            findingVerifications: findingVerifications.map((verification) =>
              record(verification.id, verification.method, verification.result, {
                findingId: verification.findingId,
                providerInvocationId: verification.providerInvocationId,
                rationale: verification.rationale,
              }),
            ),
            findings: findings.map((finding) =>
              record(finding.id, finding.category, finding.verification_status, {
                batchId: finding.batch_id,
                confidence: Number(finding.confidence),
                endLine: finding.end_line,
                fingerprint: finding.fingerprint,
                path: finding.path,
                ruleId: finding.rule_id,
                severity: finding.severity,
                source: finding.source,
                startLine: finding.start_line,
                title: finding.title,
              }),
            ),
            providerInvocations: providerInvocations.map((invocation) =>
              record(invocation.id, invocation.provider, invocation.status, {
                completedAt: iso(invocation.completed_at),
                errorCode: invocation.error_code,
                inputHash: invocation.input_hash,
                inputTokens: invocation.input_tokens,
                latencyMs: invocation.latency_ms,
                model: invocation.model,
                outputTokens: invocation.output_tokens,
                promptVersion: invocation.prompt_version,
                providerResponseId: invocation.provider_response_id,
                schemaVersion: invocation.schema_version,
              }),
            ),
            runEvents: runEvents.map((event) =>
              record(`run-event-${event.id}`, event.event_type, 'RECORDED', {
                occurredAt: requiredIso(event.occurred_at),
                payload: event.payload,
              }),
            ),
            tasks: tasks.map((task) =>
              record(task.id, task.task_type, task.status, {
                attemptCount: task.attempt_count,
                availableAt: requiredIso(task.available_at),
                maxAttempts: task.max_attempts,
                version: task.version,
              }),
            ),
          },
          run: {
            baseSha: run.baseSha,
            completedAt: iso(run.completedAt),
            coverageComplete: run.coverageComplete,
            diffHash: run.diffHash,
            headSha: run.headSha,
            id: run.id,
            model: run.model,
            organizationId: run.organizationId,
            projectId: run.projectId,
            promptVersion: run.promptVersion,
            pullRequestNumber: run.pullRequestNumber,
            repository: {
              id: normalizeIntegerLike(run.repositoryId, 'PROOF_REPOSITORY_ID_INVALID'),
              name: run.repositoryName,
              owner: run.repositoryOwner,
            },
            ruleset: {
              contentHash: run.rulesetContentHash,
              id: run.rulesetVersionId,
              publishedAt: iso(run.rulesetPublishedAt),
              status: run.rulesetStatus,
              version: run.rulesetVersion,
            },
            startedAt: iso(run.startedAt),
            status: run.status,
          },
        } satisfies M1ProofBundleSnapshot;
      });
    },
  };
}

function record(
  id: string,
  kind: string,
  status: string,
  metadata: Readonly<Record<string, unknown>>,
): ProofExecutionRecord {
  return { id, kind, metadata, status };
}

function iso(value: unknown): string | null {
  return value === null ? null : requiredIso(value);
}

function requiredIso(value: unknown): string {
  if (!(value instanceof Date)) throw new Error('PROOF_DATABASE_TIMESTAMP_INVALID');
  return value.toISOString();
}

function hashWorkerId(workerId: string): string {
  return createHash('sha256').update(workerId).digest('hex');
}

function parseSize(artifactId: string, value: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`PROOF_ARTIFACT_SIZE_INVALID:${artifactId}`);
  }
  return size;
}

function normalizeIntegerLike(value: unknown, errorCode: string): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value.toString();
  if (typeof value === 'bigint') return value.toString();
  throw new Error(errorCode);
}
