import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  M1ProofBundleExporter,
  type M1ProofBundleSnapshot,
  type ProofExecutionRecord,
  requiredM1ProofArtifactTypes,
} from './m1ProofBundle.js';

const organizationId = 'fa24710d-379b-437c-a160-f30e0a541ee5';
const projectId = '6b6570ea-01ea-4435-a11a-b9bd7022ae08';
const runId = '8fb32dbc-b4c7-4c46-9d1f-866b5d60ca23';

describe('M1ProofBundleExporter', () => {
  it('verifies every artifact and produces an honest complete L2 evidence manifest', async () => {
    const fixture = proofFixture();
    const load = vi.fn().mockResolvedValue(fixture.snapshot);
    const get = vi.fn((objectKey: string) =>
      Promise.resolve(fixture.bodies.get(objectKey) ?? Buffer.alloc(0)),
    );
    const exporter = new M1ProofBundleExporter(
      { load },
      { get },
      () => new Date('2026-08-30T02:00:00.000Z'),
    );

    const bundle = await exporter.export(organizationId, runId);

    expect(load).toHaveBeenCalledWith(organizationId, runId);
    expect(get).toHaveBeenCalledTimes(requiredM1ProofArtifactTypes.length);
    expect(bundle.files.map((file) => file.relativePath).sort()).toEqual(
      [
        'batch_summaries.json',
        'controversial_issues.json',
        'coverage-manifest.json',
        'cr-result.json',
        'html/index.html',
        'source.diff',
        'summary.txt',
      ].sort(),
    );
    expect(bundle.manifest).toMatchObject({
      exportedAt: '2026-08-30T02:00:00.000Z',
      schemaVersion: 1,
      verification: {
        artifactIntegrity: 'VERIFIED',
        complete: true,
        missingArtifactTypes: [],
        missingEvidence: [],
        nonTerminalTaskIds: [],
        unresolvedExternalEffectIds: [],
        verificationLevel: 'L2_RUNTIME_EVIDENCE',
      },
    });
  });

  it('exports incomplete runtime evidence without claiming successful dogfooding', async () => {
    const fixture = proofFixture();
    const missingType = 'summary.txt';
    const snapshot: M1ProofBundleSnapshot = {
      ...fixture.snapshot,
      artifacts: fixture.snapshot.artifacts.filter(
        (artifact) => artifact.artifactType !== missingType,
      ),
      execution: {
        ...fixture.snapshot.execution,
        externalEffects: [executionRecord('4e78804b-f526-4d80-aefd-71afbffc9673', 'UNKNOWN')],
        tasks: [executionRecord('f64fe41e-6cf3-4ead-a136-601ed79dff9b', 'FAILED')],
      },
    };
    const exporter = new M1ProofBundleExporter(
      { load: vi.fn().mockResolvedValue(snapshot) },
      {
        get: (objectKey) => Promise.resolve(fixture.bodies.get(objectKey) ?? Buffer.alloc(0)),
      },
    );

    const bundle = await exporter.export(organizationId, runId);

    expect(bundle.manifest.verification).toMatchObject({
      complete: false,
      missingArtifactTypes: [missingType],
      missingEvidence: [],
      nonTerminalTaskIds: ['f64fe41e-6cf3-4ead-a136-601ed79dff9b'],
      unresolvedExternalEffectIds: ['4e78804b-f526-4d80-aefd-71afbffc9673'],
    });
  });

  it('refuses to package bytes that do not match immutable artifact metadata', async () => {
    const fixture = proofFixture();
    const exporter = new M1ProofBundleExporter(
      { load: vi.fn().mockResolvedValue(fixture.snapshot) },
      { get: () => Promise.resolve(Buffer.from('tampered')) },
    );

    await expect(exporter.export(organizationId, runId)).rejects.toThrow(
      'PROOF_ARTIFACT_HASH_MISMATCH',
    );
  });

  it('reports every absent lineage category instead of upgrading incomplete evidence', async () => {
    const fixture = proofFixture();
    const snapshot: M1ProofBundleSnapshot = {
      ...fixture.snapshot,
      evidence: { links: [], records: [] },
      execution: {
        ...fixture.snapshot.execution,
        externalEffects: [],
        providerInvocations: [],
        tasks: [],
      },
      run: {
        ...fixture.snapshot.run,
        baseSha: null,
        coverageComplete: false,
        diffHash: null,
        headSha: null,
        ruleset: {
          ...fixture.snapshot.run.ruleset,
          publishedAt: null,
          status: 'DRAFT',
        },
        status: 'PARTIAL',
      },
    };
    const exporter = new M1ProofBundleExporter(
      { load: vi.fn().mockResolvedValue(snapshot) },
      {
        get: (objectKey) => Promise.resolve(fixture.bodies.get(objectKey) ?? Buffer.alloc(0)),
      },
    );

    const bundle = await exporter.export(organizationId, runId);

    expect(bundle.manifest.verification).toMatchObject({
      complete: false,
      missingEvidence: [
        'FROZEN_SOURCE',
        'PUBLISHED_RULESET',
        'TASKS',
        'PROVIDER_INVOCATIONS',
        'EXTERNAL_EFFECTS',
        'FROZEN_PR_DIFF',
      ],
    });
  });

  it('rejects artifact metadata whose declared byte size differs from verified storage', async () => {
    const fixture = proofFixture();
    const [firstArtifact, ...remainingArtifacts] = fixture.snapshot.artifacts;
    if (firstArtifact === undefined) throw new Error('TEST_ARTIFACT_MISSING');
    const snapshot: M1ProofBundleSnapshot = {
      ...fixture.snapshot,
      artifacts: [
        { ...firstArtifact, sizeBytes: firstArtifact.sizeBytes + 1 },
        ...remainingArtifacts,
      ],
    };
    const exporter = new M1ProofBundleExporter(
      { load: vi.fn().mockResolvedValue(snapshot) },
      {
        get: (objectKey) => Promise.resolve(fixture.bodies.get(objectKey) ?? Buffer.alloc(0)),
      },
    );

    await expect(exporter.export(organizationId, runId)).rejects.toThrow(
      'PROOF_ARTIFACT_SIZE_MISMATCH',
    );
  });
});

function proofFixture(): Readonly<{
  bodies: ReadonlyMap<string, Buffer>;
  snapshot: M1ProofBundleSnapshot;
}> {
  const bodies = new Map<string, Buffer>();
  const artifacts = requiredM1ProofArtifactTypes.map((artifactType, index) => {
    const body = Buffer.from(`artifact:${artifactType}`);
    const objectKey = `artifacts/run/${index}`;
    bodies.set(objectKey, body);
    return {
      artifactType,
      contentHash: createHash('sha256').update(body).digest('hex'),
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      mediaType: artifactType.endsWith('.json') ? 'application/json' : 'text/plain',
      objectKey,
      sizeBytes: body.byteLength,
    };
  });
  return {
    bodies,
    snapshot: {
      artifacts,
      evidence: {
        links: [
          {
            childArtifactId: artifacts[1]?.id ?? '',
            parentArtifactId: artifacts[0]?.id ?? '',
            relation: 'DERIVED_FROM',
          },
        ],
        records: [
          {
            artifactId: artifacts[0]?.id ?? null,
            evidenceType: 'FROZEN_PR_DIFF',
            id: '38286c70-ec36-4c32-9bff-fe2875aeb34b',
            metadata: { baseSha: 'base', headSha: 'head' },
            sourceHash: 'diff-hash',
          },
        ],
      },
      execution: {
        attempts: [executionRecord('39cb7f91-08c3-4bf7-8cc2-197f9b67aa67', 'SUCCEEDED')],
        batches: [executionRecord('8bddfc52-e91b-4a42-87e7-c29f50d0f7c2', 'SUCCEEDED')],
        externalEffects: [executionRecord('4e78804b-f526-4d80-aefd-71afbffc9673', 'SUCCEEDED')],
        findingVerifications: [
          executionRecord('67860dab-4d22-4478-9121-471095816e71', 'CONFIRMED'),
        ],
        findings: [executionRecord('03124a17-2f2e-420f-8697-f8172e92a9dd', 'CONFIRMED')],
        providerInvocations: [executionRecord('32bf0dcf-7bfb-41ee-8db7-413c98969cb6', 'SUCCEEDED')],
        runEvents: [executionRecord('run-event-1', 'RECORDED')],
        tasks: [executionRecord('f64fe41e-6cf3-4ead-a136-601ed79dff9b', 'SUCCEEDED')],
      },
      run: {
        baseSha: 'base',
        completedAt: '2026-08-30T01:59:00.000Z',
        coverageComplete: true,
        diffHash: 'diff-hash',
        headSha: 'head',
        id: runId,
        model: 'deepseek-v4-flash',
        organizationId,
        projectId,
        promptVersion: 'review-v1',
        pullRequestNumber: 42,
        repository: { id: '123', name: 'iWorkspace', owner: 'Alpha5402' },
        ruleset: {
          contentHash: 'ruleset-hash',
          id: '337c99a8-0034-43fe-acdf-c8ce2243097f',
          publishedAt: '2026-08-30T01:00:00.000Z',
          status: 'PUBLISHED',
          version: 1,
        },
        startedAt: '2026-08-30T01:58:00.000Z',
        status: 'SUCCEEDED',
      },
    },
  };
}

function executionRecord(id: string, status: string): ProofExecutionRecord {
  return { id, kind: 'TEST', metadata: {}, status } as const;
}
