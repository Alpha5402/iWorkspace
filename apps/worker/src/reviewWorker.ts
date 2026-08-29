import { createHash, randomUUID } from 'node:crypto';

import { EventEnvelopeV1Schema, RuleDefinitionSchema } from '@delivery/contracts';
import {
  claimOutboxEvents,
  completeInboxDelivery,
  completeTaskLease,
  completeTaskLeaseInTransaction,
  failTaskLease,
  heartbeatTaskLease,
  insertOutboxEvent,
  leaseTaskById,
  markOutboxPublished,
  ownsTaskLease,
  reapExpiredTaskLeases,
  startInboxDelivery,
  type DeliveryDatabase,
  type DeliveryTransaction,
  type OutboxEventInput,
  type TaskLease,
} from '@delivery/database';
import {
  createFindingFingerprint,
  determineCheckConclusion,
  selectCheckAnnotations,
  type ReviewFinding,
} from '@delivery/domain';
import { type RabbitMqBus, reviewQueues } from '@delivery/messaging';
import { type ImmutableArtifactStore } from '@delivery/object-storage';
import { ModelProviderError, type ReviewModelProvider } from '@delivery/providers-agent';
import { type GitHubAppProvider, GitHubProviderError } from '@delivery/providers-github';
import { z } from 'zod';

import {
  applicableRules,
  buildReviewBatches,
  parseUnifiedDiff,
  runDeterministicReview,
  type ParsedDiff,
} from './reviewHarness.js';
import { ModelInvocationRunner } from './modelInvocationRunner.js';

const CommandPayloadSchema = z.object({ runId: z.uuid(), taskId: z.uuid() });
type CommandPayload = z.infer<typeof CommandPayloadSchema>;

type WorkerLogger = Readonly<{
  error(attributes: Record<string, unknown>, message: string): void;
  info(attributes: Record<string, unknown>, message: string): void;
}>;

const TASK_EVENT: Readonly<Record<string, string>> = {
  ACQUIRE_SOURCE: 'review.acquire.requested',
  ANALYZE_REVIEW: 'review.analyze.requested',
  VERIFY_FINDINGS: 'review.verify.requested',
  PUBLISH_CHECK: 'review.publish.requested',
};

export class ReviewWorker {
  private readonly modelInvocations: ModelInvocationRunner;
  private relayTimer: NodeJS.Timeout | undefined;
  private reaperTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly database: DeliveryDatabase,
    private readonly bus: Pick<RabbitMqBus, 'close' | 'consume' | 'publish'>,
    private readonly github: Pick<
      GitHubAppProvider,
      | 'createCheckRun'
      | 'createInstallationToken'
      | 'findCheckRunByExternalId'
      | 'getPullRequestHead'
      | 'getPullRequestSnapshot'
    >,
    model: ReviewModelProvider,
    private readonly artifacts: Pick<ImmutableArtifactStore, 'close' | 'get' | 'put'>,
    private readonly detailsBaseUrl: string,
    private readonly workerId: string,
    private readonly logger: WorkerLogger,
  ) {
    this.modelInvocations = new ModelInvocationRunner(database, model, (lease) =>
      this.assertLease(lease),
    );
  }

  public async start(): Promise<void> {
    await Promise.all(
      Object.values(reviewQueues).map((queue) =>
        this.bus.consume(queue, async (message) => {
          const envelope = EventEnvelopeV1Schema.parse(
            JSON.parse(message.content.toString('utf8')),
          );
          const payload = CommandPayloadSchema.parse(envelope.payload);
          await this.consumeCommand(envelope.eventId, envelope.eventType, payload);
        }),
      ),
    );
    this.relayTimer = setInterval(() => {
      void this.relayOnce().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : 'unknown' },
          'outbox relay failed',
        );
      });
    }, 250);
    this.relayTimer.unref();
    this.reaperTimer = setInterval(() => {
      void this.reapOnce().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : 'unknown' },
          'lease reaper failed',
        );
      });
    }, 10_000);
    this.reaperTimer.unref();
    await this.relayOnce();
    await this.reapOnce();
  }

  public async close(): Promise<void> {
    if (this.relayTimer !== undefined) clearInterval(this.relayTimer);
    if (this.reaperTimer !== undefined) clearInterval(this.reaperTimer);
    this.artifacts.close();
    await this.bus.close();
  }

  private async relayOnce(): Promise<void> {
    const events = await claimOutboxEvents(this.database, this.workerId, 50);
    for (const event of events) {
      await this.bus.publish(event);
      await markOutboxPublished(this.database, event.eventId, this.workerId);
    }
  }

  private async reapOnce(): Promise<void> {
    await reapExpiredTaskLeases(this.database, (task) => {
      const eventType = TASK_EVENT[task.taskType];
      if (eventType === undefined) throw new Error(`UNSUPPORTED_TASK_TYPE:${task.taskType}`);
      return {
        ...(task.sourceEventId === undefined ? {} : { causationId: task.sourceEventId }),
        correlationId: task.runId,
        eventId: randomUUID(),
        eventType,
        organizationId: task.organizationId,
        payload: { runId: task.runId, taskId: task.taskId },
        projectId: task.projectId,
      };
    });
  }

  private async consumeCommand(
    eventId: string,
    eventType: string,
    payload: CommandPayload,
  ): Promise<void> {
    const claimed = await startInboxDelivery(
      this.database,
      'review-worker-v1',
      eventId,
      this.workerId,
    );
    if (!claimed) return;
    const lease = await leaseTaskById(this.database, payload.taskId, this.workerId, 300, eventId);
    if (lease === undefined) {
      await completeInboxDelivery(
        this.database,
        'review-worker-v1',
        eventId,
        this.workerId,
        'NO_WORK',
      );
      return;
    }
    const heartbeat = setInterval(() => {
      void heartbeatTaskLease(this.database, lease).catch(() => undefined);
    }, 60_000);
    heartbeat.unref();
    try {
      let taskCompletedInStage = false;
      if (eventType === 'review.acquire.requested') await this.acquire(payload.runId, lease);
      else if (eventType === 'review.analyze.requested') await this.analyze(payload.runId, lease);
      else if (eventType === 'review.verify.requested') await this.verify(payload.runId, lease);
      else if (eventType === 'review.publish.requested') {
        await this.publish(payload.runId, lease);
        taskCompletedInStage = true;
      } else throw new Error('UNSUPPORTED_REVIEW_EVENT');
      if (!taskCompletedInStage && !(await completeTaskLease(this.database, lease)))
        throw new Error('TASK_FENCING_REJECTED');
      await completeInboxDelivery(
        this.database,
        'review-worker-v1',
        eventId,
        this.workerId,
        'SUCCEEDED',
      );
    } catch (error) {
      await this.handleFailure(eventId, eventType, payload, lease, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async handleFailure(
    eventId: string,
    eventType: string,
    payload: CommandPayload,
    lease: TaskLease,
    error: unknown,
  ): Promise<void> {
    const errorCode =
      error instanceof ModelProviderError
        ? `MODEL_${error.code}`
        : error instanceof GitHubProviderError
          ? `GITHUB_${error.code}`
          : error instanceof Error
            ? error.message.slice(0, 120)
            : 'UNKNOWN_WORKER_ERROR';
    const retryable = ![
      'DIFF_SIZE_LIMIT_EXCEEDED',
      'GITHUB_AUTHENTICATION',
      'GITHUB_NOT_FOUND',
      'MODEL_INVALID_RESPONSE',
      'RUN_NOT_ACQUIRABLE',
      'RUN_STALE',
      'UNSUPPORTED_REVIEW_EVENT',
      'TASK_FENCING_REJECTED',
    ].includes(errorCode);
    const retryAfterSeconds =
      error instanceof ModelProviderError && error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds
        : 5;
    const retryAt = retryable
      ? new Date(Date.now() + retryAfterSeconds * 1_000 + Math.floor(Math.random() * 1_000))
      : undefined;
    const retryEvent: OutboxEventInput | undefined = retryable
      ? {
          causationId: eventId,
          correlationId: payload.runId,
          eventId: randomUUID(),
          eventType,
          organizationId: await this.organizationIdForRun(payload.runId),
          payload,
          projectId: await this.projectIdForRun(payload.runId),
        }
      : undefined;
    await failTaskLease(this.database, lease, {
      errorCode,
      ...(retryAt === undefined ? {} : { retryAt }),
      ...(retryEvent === undefined ? {} : { retryEvent }),
    });
    await completeInboxDelivery(
      this.database,
      'review-worker-v1',
      eventId,
      this.workerId,
      'FAILED',
    );
    this.logger.error({ errorCode, eventId, runId: payload.runId }, 'review task failed');
    if (!retryable) {
      await this.database
        .updateTable('review_runs')
        .set({ completed_at: new Date(), status: 'FAILED' })
        .where('id', '=', payload.runId)
        .where('status', 'not in', ['SUCCEEDED', 'PARTIAL', 'CANCELLED', 'STALE'])
        .execute();
    }
  }

  private async acquire(runId: string, lease: TaskLease): Promise<void> {
    await this.assertLease(lease);
    const run = await this.database
      .selectFrom('review_runs')
      .innerJoin(
        'repository_connections',
        'repository_connections.id',
        'review_runs.repository_connection_id',
      )
      .select([
        'review_runs.id',
        'review_runs.organization_id',
        'review_runs.project_id',
        'review_runs.base_sha',
        'review_runs.head_sha',
        'review_runs.pull_request_number',
        'review_runs.status',
        'repository_connections.installation_id',
        'repository_connections.owner_login',
        'repository_connections.repository_name',
      ])
      .where('review_runs.id', '=', runId)
      .executeTakeFirstOrThrow();
    if (run.status !== 'ACCEPTED') {
      if (
        (run.status === 'QUEUED' || run.status === 'RUNNING') &&
        run.base_sha !== null &&
        run.head_sha !== null
      ) {
        return;
      }
      throw new Error('RUN_NOT_ACQUIRABLE');
    }
    const installation = await this.github.createInstallationToken(run.installation_id);
    const snapshot = await this.github.getPullRequestSnapshot({
      installationToken: installation.token,
      owner: run.owner_login,
      pullRequestNumber: run.pull_request_number,
      repository: run.repository_name,
    });
    if (run.head_sha !== null && run.head_sha !== snapshot.headSha) {
      await this.database
        .updateTable('review_runs')
        .set({ completed_at: new Date(), status: 'STALE' })
        .where('id', '=', runId)
        .where('status', '=', 'ACCEPTED')
        .executeTakeFirstOrThrow();
      throw new Error('RUN_STALE');
    }
    const parsed = parseUnifiedDiff(snapshot.diff);
    const stored = await this.artifacts.put({
      beforeCommit: () => this.assertLease(lease),
      body: Buffer.from(snapshot.diff),
      mediaType: 'text/x-diff',
      organizationId: run.organization_id,
      projectId: run.project_id,
      runId,
    });
    await this.database.transaction().execute(async (transaction) => {
      await this.assertLease(lease, transaction);
      const sourceArtifact = await transaction
        .insertInto('artifacts')
        .values({
          artifact_type: 'SOURCE_DIFF',
          content_hash: stored.contentHash,
          media_type: 'text/x-diff',
          object_key: stored.objectKey,
          organization_id: run.organization_id,
          project_id: run.project_id,
          retention_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
          run_id: runId,
          size_bytes: String(stored.sizeBytes),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('evidence_records')
        .values({
          artifact_id: sourceArtifact.id,
          evidence_type: 'FROZEN_PR_DIFF',
          metadata: { baseSha: snapshot.baseSha, headSha: snapshot.headSha },
          organization_id: run.organization_id,
          project_id: run.project_id,
          run_id: runId,
          source_hash: parsed.contentHash,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('review_runs')
        .set({
          base_sha: snapshot.baseSha,
          diff_hash: parsed.contentHash,
          head_sha: snapshot.headSha,
          started_at: new Date(),
          status: 'QUEUED',
          version: 1,
        })
        .where('id', '=', runId)
        .where('status', '=', 'ACCEPTED')
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('run_events')
        .values({
          event_type: 'review.source_frozen',
          organization_id: run.organization_id,
          payload: {
            baseSha: snapshot.baseSha,
            diffHash: parsed.contentHash,
            headSha: snapshot.headSha,
          },
          project_id: run.project_id,
          run_id: runId,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('review_runs')
        .set({ status: 'RUNNING', version: 2 })
        .where('id', '=', runId)
        .where('status', '=', 'QUEUED')
        .executeTakeFirstOrThrow();
      await this.enqueueNext(
        transaction,
        { id: run.id, organizationId: run.organization_id, projectId: run.project_id },
        'ANALYZE_REVIEW',
      );
    });
  }

  private async analyze(runId: string, lease: TaskLease): Promise<void> {
    await this.assertLease(lease);
    const context = await this.loadReviewContext(runId);
    const diffArtifact = await this.database
      .selectFrom('artifacts')
      .select('object_key')
      .where('run_id', '=', runId)
      .where('artifact_type', '=', 'SOURCE_DIFF')
      .executeTakeFirstOrThrow();
    const diff = (await this.artifacts.get(diffArtifact.object_key)).toString('utf8');
    const parsed = parseUnifiedDiff(diff);
    const rules = RuleDefinitionSchema.array().parse(context.rules);
    const deterministicFindings = runDeterministicReview(parsed, rules);
    const modelFindings: ReviewFinding[] = [];
    const batches = buildReviewBatches(parsed.files);
    let estimatedTotal = 0;
    for (const category of ['DESIGN', 'IMPLEMENTATION', 'DEFECT'] as const) {
      for (const batch of batches) {
        estimatedTotal += batch.estimatedTokens;
        if (estimatedTotal > 100_000) break;
        const batchRules = rules.filter(
          (rule) =>
            rule.category === category &&
            batch.files.some((file) => applicableRules([rule], file.path).length > 0),
        );
        if (batchRules.length === 0) continue;
        await this.assertLease(lease);
        const batchId = await this.database
          .insertInto('review_batches')
          .values({
            category,
            estimated_tokens: batch.estimatedTokens,
            input_hash: batch.inputHash,
            organization_id: context.organizationId,
            project_id: context.projectId,
            provider_invocation_id: null,
            run_id: runId,
            sequence: batch.sequence,
            status: 'RUNNING',
          })
          .onConflict((conflict) =>
            conflict.columns(['run_id', 'category', 'sequence']).doUpdateSet({ status: 'RUNNING' }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        const result = await this.modelInvocations.invoke({
          lease,
          model: context.model,
          organizationId: context.organizationId,
          projectId: context.projectId,
          promptVersion: context.promptVersion,
          request: {
            category,
            diff: batch.files.map((file) => file.patch).join('\n'),
            promptVersion: context.promptVersion,
            rules: batchRules.map((rule) => ({
              evidenceRequirement: rule.evidenceRequirement,
              guidance: rule.guidance,
              id: rule.id,
              severity: rule.defaultSeverity,
              title: rule.title,
            })),
          },
          runId,
        });
        await this.database
          .updateTable('review_batches')
          .set({ provider_invocation_id: result.invocationId })
          .where('id', '=', batchId.id)
          .executeTakeFirstOrThrow();
        for (const candidate of result.output.findings) {
          const location = batch.files
            .find((file) => file.path === candidate.path)
            ?.additions.find(
              (line) => line.line >= candidate.startLine && line.line <= candidate.endLine,
            );
          if (location === undefined || !batchRules.some((rule) => rule.id === candidate.ruleId))
            continue;
          modelFindings.push({
            batchId: batchId.id,
            confidence: candidate.confidence,
            description: candidate.description,
            endLine: candidate.endLine,
            evidence: candidate.evidence,
            fingerprint: createFindingFingerprint({
              codeIdentity: createHash('sha256').update(location.content).digest('hex'),
              message: candidate.description,
              path: candidate.path,
              ruleId: candidate.ruleId,
            }),
            path: candidate.path,
            ruleId: candidate.ruleId,
            severity: candidate.severity,
            startLine: candidate.startLine,
            title: candidate.title,
            verificationStatus:
              candidate.severity === 'BLOCKING' || candidate.severity === 'MAJOR'
                ? 'NEEDS_HUMAN'
                : 'CONFIRMED',
          });
        }
        await this.database
          .updateTable('review_batches')
          .set({ status: 'SUCCEEDED' })
          .where('id', '=', batchId.id)
          .executeTakeFirstOrThrow();
      }
    }
    const deduplicated = new Map<string, ReviewFinding>();
    for (const finding of [...deterministicFindings, ...modelFindings]) {
      const current = deduplicated.get(finding.fingerprint);
      if (current === undefined || finding.confidence > current.confidence) {
        deduplicated.set(finding.fingerprint, finding);
      }
    }
    await this.database.transaction().execute(async (transaction) => {
      await this.assertLease(lease, transaction);
      for (const finding of deduplicated.values()) {
        const deterministic = deterministicFindings.some(
          (entry) => entry.fingerprint === finding.fingerprint,
        );
        const inserted = await transaction
          .insertInto('review_findings')
          .values({
            batch_id: finding.batchId ?? null,
            category: rules.find((rule) => rule.id === finding.ruleId)?.category ?? 'DEFECT',
            confidence: finding.confidence,
            description: finding.description,
            end_line: finding.endLine,
            evidence: JSON.stringify(finding.evidence),
            fingerprint: finding.fingerprint,
            organization_id: context.organizationId,
            path: finding.path,
            project_id: context.projectId,
            rule_id: finding.ruleId,
            run_id: runId,
            severity: finding.severity,
            side: 'RIGHT',
            source: deterministic ? 'DETERMINISTIC' : 'MODEL',
            start_line: finding.startLine,
            title: finding.title,
            verification_status: finding.verificationStatus,
          })
          .onConflict((conflict) => conflict.columns(['run_id', 'fingerprint']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted !== undefined && deterministic) {
          await transaction
            .insertInto('finding_verifications')
            .values({
              finding_id: inserted.id,
              method: 'DETERMINISTIC',
              provider_invocation_id: null,
              rationale: 'Trusted deterministic handler matched an added line in the frozen diff.',
              result: 'CONFIRMED',
            })
            .execute();
        }
      }
      await this.enqueueNext(transaction, context, 'VERIFY_FINDINGS');
    });
  }

  private async verify(runId: string, lease: TaskLease): Promise<void> {
    await this.assertLease(lease);
    const context = await this.loadReviewContext(runId);
    const unresolved = await this.database
      .selectFrom('review_findings')
      .selectAll()
      .where('run_id', '=', runId)
      .where('verification_status', '=', 'NEEDS_HUMAN')
      .orderBy('confidence', 'desc')
      .limit(20)
      .execute();
    const diffArtifact = await this.database
      .selectFrom('artifacts')
      .select('object_key')
      .where('run_id', '=', runId)
      .where('artifact_type', '=', 'SOURCE_DIFF')
      .executeTakeFirstOrThrow();
    const parsed = parseUnifiedDiff(
      (await this.artifacts.get(diffArtifact.object_key)).toString('utf8'),
    );
    const rules = RuleDefinitionSchema.array().parse(context.rules);
    for (const finding of unresolved) {
      await this.assertLease(lease);
      const file = parsed.files.find((entry) => entry.path === finding.path);
      const rule = rules.find((entry) => entry.id === finding.rule_id);
      if (file === undefined || rule === undefined) {
        await this.setFindingVerification(
          finding.id,
          'REJECTED',
          lease,
          'DETERMINISTIC',
          'Finding no longer maps to a frozen diff location and applicable rule.',
        );
        continue;
      }
      const result = await this.modelInvocations.invoke({
        lease,
        model: context.model,
        organizationId: context.organizationId,
        projectId: context.projectId,
        promptVersion: `${context.promptVersion}-verify`,
        request: {
          category: rule.category,
          diff: file.patch,
          promptVersion: `${context.promptVersion}-verify`,
          rules: [
            {
              evidenceRequirement: rule.evidenceRequirement,
              guidance: `Independently verify this candidate: ${finding.description}`,
              id: rule.id,
              severity: rule.defaultSeverity,
              title: rule.title,
            },
          ],
        },
        runId,
      });
      await this.assertLease(lease);
      const corroborated = result.output.findings.some(
        (candidate) =>
          candidate.ruleId === finding.rule_id &&
          candidate.path === finding.path &&
          candidate.startLine <= finding.end_line &&
          candidate.endLine >= finding.start_line,
      );
      await this.setFindingVerification(
        finding.id,
        corroborated ? 'CONFIRMED' : 'DISPUTED',
        lease,
        'MODEL',
        corroborated
          ? 'Independent review corroborated the candidate.'
          : 'Independent review did not corroborate the candidate.',
        result.invocationId,
      );
    }
    await this.database.transaction().execute(async (transaction) => {
      await this.assertLease(lease, transaction);
      await this.enqueueNext(transaction, context, 'PUBLISH_CHECK');
    });
  }

  private async publish(runId: string, lease: TaskLease): Promise<void> {
    await this.assertLease(lease);
    const context = await this.loadReviewContext(runId);
    if (context.headSha === null) throw new Error('RUN_INPUT_NOT_FROZEN');
    if (!(await this.ensureCurrentHead(context, lease))) return;
    const rows = await this.database
      .selectFrom('review_findings')
      .selectAll()
      .where('run_id', '=', runId)
      .execute();
    const findings: ReviewFinding[] = rows.map((finding) => ({
      confidence: Number(finding.confidence),
      ...(finding.batch_id === null ? {} : { batchId: finding.batch_id }),
      description: finding.description,
      endLine: finding.end_line,
      evidence: finding.evidence as readonly string[],
      fingerprint: finding.fingerprint,
      path: finding.path,
      ruleId: finding.rule_id,
      severity: finding.severity,
      startLine: finding.start_line,
      title: finding.title,
      verificationStatus: finding.verification_status,
    }));
    const coverage = await this.coverageForRun(runId);
    const finalStatus = coverage.coverageComplete ? 'SUCCEEDED' : 'PARTIAL';
    const conclusion = determineCheckConclusion({
      coverageComplete: coverage.coverageComplete,
      findings,
      runStatus: finalStatus,
    });
    await this.writeReportArtifacts(context, findings, coverage, lease);
    await this.assertLease(lease);
    const effectKey = `github:check:${context.repositoryId}:${context.headSha}:${runId}`;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({ conclusion, findings: findings.map((finding) => finding.fingerprint) }),
      )
      .digest('hex');
    const effect = await this.database.transaction().execute(async (transaction) => {
      await this.assertLease(lease, transaction);
      return transaction
        .insertInto('external_effects')
        .values({
          attempt_count: 0,
          effect_type: 'CHECK_RUN',
          last_error_code: null,
          logical_key: effectKey,
          organization_id: context.organizationId,
          project_id: context.projectId,
          provider: 'github',
          provider_object_id: null,
          request_hash: requestHash,
          run_id: runId,
          status: 'PREPARED',
        })
        .onConflict((conflict) =>
          conflict.columns(['provider', 'effect_type', 'logical_key']).doUpdateSet({
            updated_at: new Date(),
          }),
        )
        .returning(['attempt_count', 'id', 'provider_object_id', 'status'])
        .executeTakeFirstOrThrow();
    });
    if (
      (effect.status === 'UNKNOWN' || effect.status === 'IN_FLIGHT') &&
      effect.provider_object_id === null
    ) {
      const installation = await this.github.createInstallationToken(context.installationId);
      await this.assertLease(lease);
      const recoveredProviderId = await this.github.findCheckRunByExternalId({
        externalId: runId,
        headSha: context.headSha,
        installationToken: installation.token,
        owner: context.owner,
        repository: context.repositoryName,
      });
      if (recoveredProviderId === undefined) throw new Error('GITHUB_RESULT_UNKNOWN');
      await this.database.transaction().execute(async (transaction) => {
        await this.assertLease(lease, transaction);
        await transaction
          .updateTable('external_effects')
          .set({
            provider_object_id: recoveredProviderId,
            status: 'SUCCEEDED',
            updated_at: new Date(),
          })
          .where('id', '=', effect.id)
          .where('status', 'in', ['UNKNOWN', 'IN_FLIGHT'])
          .executeTakeFirstOrThrow();
      });
    }
    if (effect.status === 'PREPARED' || effect.status === 'FAILED') {
      // Installation-token acquisition cannot create a Check Run. Keep it outside the
      // uncertain-effect window so an authentication/rate-limit failure remains safely retryable
      // (or terminal) instead of being mislabeled as an UNKNOWN remote write.
      const installation = await this.github.createInstallationToken(context.installationId);
      await this.assertLease(lease);
      await this.database.transaction().execute(async (transaction) => {
        await this.assertLease(lease, transaction);
        const claimedEffect = await transaction
          .updateTable('external_effects')
          .set({
            attempt_count: effect.attempt_count + 1,
            status: 'IN_FLIGHT',
            updated_at: new Date(),
          })
          .where('id', '=', effect.id)
          .where('status', 'in', ['PREPARED', 'FAILED'])
          .executeTakeFirst();
        if (claimedEffect.numUpdatedRows !== 1n) throw new Error('EXTERNAL_EFFECT_NOT_CLAIMED');
      });
      try {
        const providerObjectId = await this.github.createCheckRun({
          annotations: selectCheckAnnotations(findings).map((finding) => ({
            annotation_level:
              finding.severity === 'BLOCKING'
                ? 'failure'
                : finding.severity === 'MAJOR'
                  ? 'warning'
                  : 'notice',
            end_line: finding.endLine,
            message: finding.description,
            path: finding.path,
            start_line: finding.startLine,
            title: finding.title,
          })),
          conclusion,
          detailsUrl: `${this.detailsBaseUrl}/reviews/${runId}`,
          externalId: runId,
          headSha: context.headSha,
          installationToken: installation.token,
          name: 'iWorkspace Review',
          owner: context.owner,
          repository: context.repositoryName,
          summary: this.summary(findings, coverage.coverageComplete),
          title: `Review ${conclusion}`,
        });
        await this.database.transaction().execute(async (transaction) => {
          await this.assertLease(lease, transaction);
          await transaction
            .updateTable('external_effects')
            .set({
              provider_object_id: providerObjectId,
              status: 'SUCCEEDED',
              updated_at: new Date(),
            })
            .where('id', '=', effect.id)
            .where('status', '=', 'IN_FLIGHT')
            .executeTakeFirstOrThrow();
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'TASK_FENCING_REJECTED') throw error;
        await this.database.transaction().execute(async (transaction) => {
          await this.assertLease(lease, transaction);
          await transaction
            .updateTable('external_effects')
            .set({
              last_error_code: 'GITHUB_RESULT_UNKNOWN',
              status: 'UNKNOWN',
              updated_at: new Date(),
            })
            .where('id', '=', effect.id)
            .where('status', '=', 'IN_FLIGHT')
            .execute();
        });
        throw new Error('GITHUB_RESULT_UNKNOWN', { cause: error });
      }
    }
    await this.database.transaction().execute(async (transaction) => {
      await this.assertLease(lease, transaction);
      if (!(await completeTaskLeaseInTransaction(transaction, lease))) {
        throw new Error('TASK_FENCING_REJECTED');
      }
      await transaction
        .updateTable('review_runs')
        .set({
          completed_at: new Date(),
          coverage_complete: coverage.coverageComplete,
          status: finalStatus,
        })
        .where('id', '=', runId)
        .where('status', '=', 'RUNNING')
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('run_events')
        .values({
          event_type: 'review.completed',
          organization_id: context.organizationId,
          payload: { conclusion, status: finalStatus },
          project_id: context.projectId,
          run_id: runId,
        })
        .executeTakeFirstOrThrow();
    });
  }

  private async enqueueNext(
    transaction: DeliveryTransaction,
    context: Readonly<{ organizationId: string; projectId: string; id?: string }>,
    taskType: 'ANALYZE_REVIEW' | 'VERIFY_FINDINGS' | 'PUBLISH_CHECK',
  ): Promise<void> {
    const runId = context.id;
    if (runId === undefined) throw new Error('RUN_ID_REQUIRED');
    const task = await transaction
      .insertInto('tasks')
      .values({
        attempt_count: 0,
        available_at: new Date(),
        max_attempts: 3,
        organization_id: context.organizationId,
        project_id: context.projectId,
        run_id: runId,
        status: 'PENDING',
        task_type: taskType,
        version: 0,
      })
      .onConflict((conflict) =>
        conflict.columns(['run_id', 'task_type']).doUpdateSet({ available_at: new Date() }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    await insertOutboxEvent(transaction, {
      correlationId: runId,
      eventId: randomUUID(),
      eventType: TASK_EVENT[taskType] ?? 'review.analyze.requested',
      organizationId: context.organizationId,
      payload: { runId, taskId: task.id },
      projectId: context.projectId,
    });
  }

  private async loadReviewContext(runId: string): Promise<
    Readonly<{
      headSha: string | null;
      id: string;
      installationId: string;
      model: string;
      organizationId: string;
      owner: string;
      projectId: string;
      promptVersion: string;
      pullRequestNumber: number;
      repositoryId: string;
      repositoryName: string;
      rules: readonly unknown[];
    }>
  > {
    const row = await this.database
      .selectFrom('review_runs')
      .innerJoin(
        'repository_connections',
        'repository_connections.id',
        'review_runs.repository_connection_id',
      )
      .innerJoin('ruleset_versions', 'ruleset_versions.id', 'review_runs.ruleset_version_id')
      .select([
        'review_runs.id',
        'review_runs.organization_id as organizationId',
        'review_runs.project_id as projectId',
        'review_runs.head_sha as headSha',
        'review_runs.model',
        'review_runs.prompt_version as promptVersion',
        'review_runs.pull_request_number as pullRequestNumber',
        'repository_connections.installation_id as installationId',
        'repository_connections.repository_id as repositoryId',
        'repository_connections.owner_login as owner',
        'repository_connections.repository_name as repositoryName',
        'ruleset_versions.rules',
      ])
      .where('review_runs.id', '=', runId)
      .executeTakeFirstOrThrow();
    return { ...row, rules: row.rules };
  }

  private async coverageForRun(runId: string): Promise<
    Readonly<{
      coverageComplete: boolean;
      omitted: ParsedDiff['omitted'];
    }>
  > {
    const source = await this.database
      .selectFrom('artifacts')
      .select('object_key')
      .where('run_id', '=', runId)
      .where('artifact_type', '=', 'SOURCE_DIFF')
      .executeTakeFirstOrThrow();
    const parsed = parseUnifiedDiff((await this.artifacts.get(source.object_key)).toString('utf8'));
    return { coverageComplete: parsed.coverageComplete, omitted: parsed.omitted };
  }

  private async ensureCurrentHead(
    context: Awaited<ReturnType<ReviewWorker['loadReviewContext']>>,
    lease: TaskLease,
  ): Promise<boolean> {
    if (context.headSha === null) return false;
    const installation = await this.github.createInstallationToken(context.installationId);
    const currentHead = await this.github.getPullRequestHead({
      installationToken: installation.token,
      owner: context.owner,
      pullRequestNumber: context.pullRequestNumber,
      repository: context.repositoryName,
    });
    await this.assertLease(lease);
    if (currentHead === context.headSha) return true;
    await this.database.transaction().execute(async (transaction) => {
      await this.assertLease(lease, transaction);
      await transaction
        .updateTable('review_runs')
        .set({ completed_at: new Date(), status: 'STALE' })
        .where('id', '=', context.id)
        .where('status', '=', 'RUNNING')
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('run_events')
        .values({
          event_type: 'review.stale',
          organization_id: context.organizationId,
          payload: { actualHeadSha: currentHead, frozenHeadSha: context.headSha },
          project_id: context.projectId,
          run_id: context.id,
        })
        .executeTakeFirstOrThrow();
    });
    return false;
  }

  private async writeReportArtifacts(
    context: Awaited<ReturnType<ReviewWorker['loadReviewContext']>>,
    findings: readonly ReviewFinding[],
    coverage: Readonly<{ coverageComplete: boolean; omitted: ParsedDiff['omitted'] }>,
    lease: TaskLease,
  ): Promise<void> {
    const sourceArtifact = await this.database
      .selectFrom('artifacts')
      .select('id')
      .where('run_id', '=', context.id)
      .where('artifact_type', '=', 'SOURCE_DIFF')
      .executeTakeFirstOrThrow();
    const batchSummaries = await this.database
      .selectFrom('review_batches')
      .select([
        'category',
        'sequence',
        'input_hash as inputHash',
        'estimated_tokens as estimatedTokens',
        'status',
      ])
      .where('run_id', '=', context.id)
      .orderBy('category', 'asc')
      .orderBy('sequence', 'asc')
      .execute();
    const controversial = findings.filter(
      (finding) =>
        finding.verificationStatus === 'DISPUTED' || finding.verificationStatus === 'NEEDS_HUMAN',
    );
    const reports = [
      {
        body: JSON.stringify({ findings }, null, 2),
        mediaType: 'application/json',
        type: 'cr-result.json',
      },
      {
        body: JSON.stringify({ findings: controversial }, null, 2),
        mediaType: 'application/json',
        type: 'controversial_issues.json',
      },
      {
        body: JSON.stringify({ batches: batchSummaries }, null, 2),
        mediaType: 'application/json',
        type: 'batch_summaries.json',
      },
      {
        body: JSON.stringify(coverage, null, 2),
        mediaType: 'application/json',
        type: 'coverage-manifest.json',
      },
      {
        body: this.summary(findings, coverage.coverageComplete),
        mediaType: 'text/plain',
        type: 'summary.txt',
      },
      { body: this.htmlReport(findings), mediaType: 'text/html', type: 'html/index.html' },
    ];
    for (const report of reports) {
      const stored = await this.artifacts.put({
        beforeCommit: () => this.assertLease(lease),
        body: Buffer.from(report.body),
        mediaType: report.mediaType,
        organizationId: context.organizationId,
        projectId: context.projectId,
        runId: context.id,
      });
      await this.database.transaction().execute(async (transaction) => {
        await this.assertLease(lease, transaction);
        let artifact = await transaction
          .insertInto('artifacts')
          .values({
            artifact_type: report.type,
            content_hash: stored.contentHash,
            media_type: report.mediaType,
            object_key: stored.objectKey,
            organization_id: context.organizationId,
            project_id: context.projectId,
            retention_until: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
            run_id: context.id,
            size_bytes: String(stored.sizeBytes),
          })
          .onConflict((conflict) =>
            conflict.columns(['run_id', 'artifact_type', 'content_hash']).doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        artifact ??= await transaction
          .selectFrom('artifacts')
          .select('id')
          .where('run_id', '=', context.id)
          .where('artifact_type', '=', report.type)
          .where('content_hash', '=', stored.contentHash)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('artifact_links')
          .values({
            child_artifact_id: artifact.id,
            organization_id: context.organizationId,
            parent_artifact_id: sourceArtifact.id,
            project_id: context.projectId,
            relation: 'DERIVED_FROM',
          })
          .onConflict((conflict) =>
            conflict.columns(['parent_artifact_id', 'child_artifact_id', 'relation']).doNothing(),
          )
          .execute();
      });
    }
  }

  private summary(findings: readonly ReviewFinding[], coverageComplete: boolean): string {
    const confirmed = findings.filter((finding) => finding.verificationStatus === 'CONFIRMED');
    return [
      `Coverage: ${coverageComplete ? 'complete' : 'partial'}`,
      `Confirmed blocking: ${confirmed.filter((finding) => finding.severity === 'BLOCKING').length}`,
      `Confirmed major: ${confirmed.filter((finding) => finding.severity === 'MAJOR').length}`,
      `Other findings: ${findings.length - confirmed.length}`,
    ].join('\n');
  }

  private htmlReport(findings: readonly ReviewFinding[]): string {
    const escape = (value: string): string =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const rows = findings
      .map(
        (finding) =>
          `<tr><td>${escape(finding.severity)}</td><td>${escape(finding.path)}:${finding.startLine}</td><td>${escape(finding.title)}</td><td>${escape(finding.verificationStatus)}</td></tr>`,
      )
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>iWorkspace Review</title></head><body><h1>Review findings</h1><table><thead><tr><th>Severity</th><th>Location</th><th>Finding</th><th>Verify</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  }

  private async setFindingVerification(
    findingId: string,
    status: 'CONFIRMED' | 'DISPUTED' | 'REJECTED',
    lease: TaskLease,
    method: 'DETERMINISTIC' | 'MODEL',
    rationale: string,
    providerInvocationId?: string,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await this.assertLease(lease, transaction);
      const updated = await transaction
        .updateTable('review_findings')
        .set({ verification_status: status })
        .where('id', '=', findingId)
        .where('verification_status', '=', 'NEEDS_HUMAN')
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new Error('FINDING_ALREADY_VERIFIED');
      await transaction
        .insertInto('finding_verifications')
        .values({
          finding_id: findingId,
          method,
          provider_invocation_id: providerInvocationId ?? null,
          rationale,
          result: status,
        })
        .executeTakeFirstOrThrow();
    });
  }

  private async assertLease(
    lease: TaskLease,
    database: DeliveryDatabase | DeliveryTransaction = this.database,
  ): Promise<void> {
    if (!(await ownsTaskLease(database, lease))) throw new Error('TASK_FENCING_REJECTED');
  }

  private async organizationIdForRun(runId: string): Promise<string> {
    return (
      await this.database
        .selectFrom('review_runs')
        .select('organization_id')
        .where('id', '=', runId)
        .executeTakeFirstOrThrow()
    ).organization_id;
  }

  private async projectIdForRun(runId: string): Promise<string> {
    return (
      await this.database
        .selectFrom('review_runs')
        .select('project_id')
        .where('id', '=', runId)
        .executeTakeFirstOrThrow()
    ).project_id;
  }
}
