import { createHash } from 'node:crypto';

import { M1ProofBundleManifestV1Schema, type M1ProofBundleManifestV1 } from '@delivery/contracts';

export const requiredM1ProofArtifactTypes = [
  'SOURCE_DIFF',
  'cr-result.json',
  'controversial_issues.json',
  'batch_summaries.json',
  'coverage-manifest.json',
  'summary.txt',
  'html/index.html',
] as const;

export type ProofExecutionRecord = Readonly<{
  id: string;
  kind: string;
  metadata: Readonly<Record<string, unknown>>;
  status: string;
}>;

type ProofBundleArtifact = Readonly<{
  artifactType: string;
  contentHash: string;
  id: string;
  mediaType: string;
  objectKey: string;
  sizeBytes: number;
}>;

export type M1ProofBundleSnapshot = Readonly<{
  artifacts: readonly ProofBundleArtifact[];
  evidence: M1ProofBundleManifestV1['evidence'];
  execution: M1ProofBundleManifestV1['execution'];
  run: M1ProofBundleManifestV1['run'];
}>;

export type M1ProofBundleRepository = Readonly<{
  load(organizationId: string, runId: string): Promise<M1ProofBundleSnapshot>;
}>;

export type ProofArtifactReader = Readonly<{
  get(objectKey: string): Promise<Buffer>;
}>;

export type ExportedM1ProofBundle = Readonly<{
  files: readonly Readonly<{ body: Buffer; relativePath: string }>[];
  manifest: M1ProofBundleManifestV1;
}>;

export class M1ProofBundleExporter {
  public constructor(
    private readonly repository: M1ProofBundleRepository,
    private readonly artifactReader: ProofArtifactReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async export(organizationId: string, runId: string): Promise<ExportedM1ProofBundle> {
    const snapshot = await this.repository.load(organizationId, runId);
    const orderedArtifacts = snapshot.artifacts.toSorted(
      (left, right) =>
        left.artifactType.localeCompare(right.artifactType) || left.id.localeCompare(right.id),
    );
    const artifactTypeCounts = countArtifactTypes(orderedArtifacts);
    const verifiedArtifacts = await Promise.all(
      orderedArtifacts.map(async (artifact) => {
        const body = await this.artifactReader.get(artifact.objectKey);
        const actualHash = createHash('sha256').update(body).digest('hex');
        if (actualHash !== artifact.contentHash) {
          throw new Error(`PROOF_ARTIFACT_HASH_MISMATCH:${artifact.id}`);
        }
        if (body.byteLength !== artifact.sizeBytes) {
          throw new Error(`PROOF_ARTIFACT_SIZE_MISMATCH:${artifact.id}`);
        }
        const relativePath = artifactRelativePath(artifact, artifactTypeCounts);
        return {
          body,
          manifest: {
            artifactId: artifact.id,
            artifactType: artifact.artifactType,
            contentHash: artifact.contentHash,
            mediaType: artifact.mediaType,
            relativePath,
            sizeBytes: artifact.sizeBytes,
          },
          relativePath,
        };
      }),
    );
    const presentArtifactTypes = new Set(
      verifiedArtifacts.map((artifact) => artifact.manifest.artifactType),
    );
    const missingArtifactTypes = requiredM1ProofArtifactTypes.filter(
      (artifactType) => !presentArtifactTypes.has(artifactType),
    );
    const nonTerminalTaskIds = snapshot.execution.tasks
      .filter((task) => task.status !== 'SUCCEEDED')
      .map((task) => task.id);
    const unresolvedExternalEffectIds = snapshot.execution.externalEffects
      .filter((effect) => effect.status !== 'SUCCEEDED')
      .map((effect) => effect.id);
    const missingEvidence = [
      ...(snapshot.run.baseSha === null ||
      snapshot.run.headSha === null ||
      snapshot.run.diffHash === null
        ? ['FROZEN_SOURCE']
        : []),
      ...(snapshot.run.ruleset.status === 'PUBLISHED' ? [] : ['PUBLISHED_RULESET']),
      ...(snapshot.execution.tasks.length === 0 ? ['TASKS'] : []),
      ...(snapshot.execution.providerInvocations.length === 0 ? ['PROVIDER_INVOCATIONS'] : []),
      ...(snapshot.execution.externalEffects.length === 0 ? ['EXTERNAL_EFFECTS'] : []),
      ...(snapshot.evidence.records.some((record) => record.evidenceType === 'FROZEN_PR_DIFF')
        ? []
        : ['FROZEN_PR_DIFF']),
    ];
    const manifest = M1ProofBundleManifestV1Schema.parse({
      artifacts: verifiedArtifacts.map((artifact) => artifact.manifest),
      evidence: snapshot.evidence,
      execution: snapshot.execution,
      exportedAt: this.now().toISOString(),
      run: snapshot.run,
      schemaVersion: 1,
      verification: {
        artifactIntegrity: 'VERIFIED',
        complete:
          snapshot.run.status === 'SUCCEEDED' &&
          snapshot.run.coverageComplete &&
          missingArtifactTypes.length === 0 &&
          missingEvidence.length === 0 &&
          nonTerminalTaskIds.length === 0 &&
          unresolvedExternalEffectIds.length === 0,
        missingArtifactTypes,
        missingEvidence,
        nonTerminalTaskIds,
        unresolvedExternalEffectIds,
        verificationLevel: 'L2_RUNTIME_EVIDENCE',
      },
    });
    return {
      files: verifiedArtifacts.map(({ body, relativePath }) => ({ body, relativePath })),
      manifest,
    };
  }
}

function countArtifactTypes(
  artifacts: readonly ProofBundleArtifact[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    counts.set(artifact.artifactType, (counts.get(artifact.artifactType) ?? 0) + 1);
  }
  return counts;
}

function artifactRelativePath(
  artifact: ProofBundleArtifact,
  artifactTypeCounts: ReadonlyMap<string, number>,
): string {
  const knownPath = requiredM1ProofArtifactTypes.includes(
    artifact.artifactType as (typeof requiredM1ProofArtifactTypes)[number],
  )
    ? artifact.artifactType === 'SOURCE_DIFF'
      ? 'source.diff'
      : artifact.artifactType
    : `additional/${artifact.id}-${sanitizePathSegment(artifact.artifactType)}`;
  return artifactTypeCounts.get(artifact.artifactType) === 1
    ? knownPath
    : `duplicates/${artifact.id}/${knownPath}`;
}

function sanitizePathSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
}
