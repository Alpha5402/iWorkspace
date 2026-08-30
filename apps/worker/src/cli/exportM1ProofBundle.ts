import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, join, resolve, sep } from 'node:path';

import { createDatabase } from '@delivery/database';
import { ImmutableArtifactStore } from '@delivery/object-storage';
import { z } from 'zod';

import { M1ProofBundleExporter } from '../m1ProofBundle.js';
import { createPostgresM1ProofBundleRepository } from '../m1ProofBundleRepository.js';

const ProofExportEnvironmentSchema = z.object({
  DATABASE_URL: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
});

const parsedArguments = parseArgs({
  allowPositionals: false,
  options: {
    'organization-id': { type: 'string' },
    output: { type: 'string' },
    'run-id': { type: 'string' },
  },
  strict: true,
});
const organizationId = z.uuid().parse(parsedArguments.values['organization-id']);
const runId = z.uuid().parse(parsedArguments.values['run-id']);
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const outputDirectory = resolve(
  invocationDirectory,
  parsedArguments.values.output ?? `.workspace/proofs/m1-proof-${runId}`,
);
const environment = ProofExportEnvironmentSchema.parse(process.env);
const database = createDatabase(environment.DATABASE_URL, 2);
const artifactStore = new ImmutableArtifactStore({
  accessKeyId: environment.S3_ACCESS_KEY,
  bucket: environment.S3_BUCKET,
  endpoint: environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  secretAccessKey: environment.S3_SECRET_KEY,
});

try {
  const exporter = new M1ProofBundleExporter(
    createPostgresM1ProofBundleRepository(database),
    artifactStore,
  );
  const bundle = await exporter.export(organizationId, runId);
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  let temporaryDirectory: string | undefined = await mkdtemp(join(outputParent, '.m1-proof-tmp-'));
  try {
    for (const file of bundle.files) {
      const destination = resolve(temporaryDirectory, file.relativePath);
      if (!destination.startsWith(`${temporaryDirectory}${sep}`)) {
        throw new Error('PROOF_OUTPUT_PATH_ESCAPE_REJECTED');
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.body, { flag: 'wx' });
    }
    await writeFile(
      join(temporaryDirectory, 'manifest.v1.json'),
      `${JSON.stringify(bundle.manifest, null, 2)}\n`,
      { flag: 'wx' },
    );
    await rename(temporaryDirectory, outputDirectory);
    temporaryDirectory = undefined;
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      artifactCount: bundle.manifest.artifacts.length,
      complete: bundle.manifest.verification.complete,
      outputDirectory,
      runId,
      verificationLevel: bundle.manifest.verification.verificationLevel,
    })}\n`,
  );
  if (!bundle.manifest.verification.complete) process.exitCode = 2;
} finally {
  artifactStore.close();
  await database.destroy();
}
