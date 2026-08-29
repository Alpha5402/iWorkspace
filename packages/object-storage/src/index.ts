import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { type DependencyProbe } from '@delivery/health';

export type ObjectStorageConfig = Readonly<{
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
}>;

type ObjectStorageHealthClient = Readonly<{
  destroy(): void;
  send(command: HeadBucketCommand): Promise<unknown>;
}>;

type ObjectStorageHealthClientFactory = (config: ObjectStorageConfig) => ObjectStorageHealthClient;

const createDefaultClient: ObjectStorageHealthClientFactory = (config) =>
  new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: true,
    region: config.region,
  });

export function createObjectStorageProbe(
  config: ObjectStorageConfig,
  clientFactory: ObjectStorageHealthClientFactory = createDefaultClient,
): DependencyProbe {
  const client = clientFactory(config);

  return {
    name: 'objectStorage',
    async check() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        return { name: 'objectStorage', status: 'up' };
      } catch {
        return { name: 'objectStorage', status: 'down' };
      }
    },
    close() {
      client.destroy();
      return Promise.resolve();
    },
  };
}

export type StoredArtifact = Readonly<{
  contentHash: string;
  objectKey: string;
  sizeBytes: number;
}>;

type ArtifactStorageClient = Readonly<{
  destroy(): void;
  send(
    command:
      | CopyObjectCommand
      | DeleteObjectCommand
      | GetObjectCommand
      | HeadObjectCommand
      | ListObjectsV2Command
      | PutObjectCommand,
  ): Promise<unknown>;
}>;

const createDefaultArtifactClient = (config: ObjectStorageConfig): ArtifactStorageClient =>
  new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: true,
    region: config.region,
  });

export class ImmutableArtifactStore {
  private readonly client: ArtifactStorageClient;

  public constructor(
    private readonly config: ObjectStorageConfig,
    clientFactory: (
      config: ObjectStorageConfig,
    ) => ArtifactStorageClient = createDefaultArtifactClient,
  ) {
    this.client = clientFactory(config);
  }

  public async put(
    input: Readonly<{
      beforeCommit?: () => Promise<void>;
      body: Buffer;
      mediaType: string;
      organizationId: string;
      projectId: string;
      runId: string;
    }>,
  ): Promise<StoredArtifact> {
    const contentHash = createHash('sha256').update(input.body).digest('hex');
    const temporaryKey = `tmp/${input.organizationId}/${input.runId}/${randomUUID()}`;
    const objectKey = `artifacts/${input.organizationId}/${input.projectId}/${input.runId}/${contentHash}`;
    await this.client.send(
      new PutObjectCommand({
        Body: input.body,
        Bucket: this.config.bucket,
        ContentType: input.mediaType,
        Key: temporaryKey,
        Metadata: { sha256: contentHash },
      }),
    );
    try {
      const head = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: temporaryKey }),
      )) as Readonly<{ ContentLength?: number; Metadata?: Record<string, string> }>;
      if (head.ContentLength !== input.body.byteLength || head.Metadata?.sha256 !== contentHash) {
        throw new Error('ARTIFACT_UPLOAD_VERIFICATION_FAILED');
      }
      await input.beforeCommit?.();
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.config.bucket,
          CopySource: `${this.config.bucket}/${temporaryKey}`,
          Key: objectKey,
          Metadata: { sha256: contentHash },
          MetadataDirective: 'REPLACE',
        }),
      );
      return { contentHash, objectKey, sizeBytes: input.body.byteLength };
    } finally {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: temporaryKey }),
      );
    }
  }

  public async get(objectKey: string): Promise<Buffer> {
    const result = (await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
    )) as Readonly<{ Body?: Readonly<{ transformToByteArray(): Promise<Uint8Array> }> }>;
    if (result.Body === undefined) throw new Error('ARTIFACT_BODY_MISSING');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  public async list(
    prefix: 'artifacts/' | 'tmp/',
    continuationToken?: string,
    maximumKeys = 500,
  ): Promise<
    Readonly<{
      continuationToken?: string;
      objects: readonly Readonly<{ key: string; lastModified: Date; sizeBytes: number }>[];
    }>
  > {
    const result = (await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        MaxKeys: maximumKeys,
        Prefix: prefix,
      }),
    )) as Readonly<{
      Contents?: readonly Readonly<{ Key?: string; LastModified?: Date; Size?: number }>[];
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    }>;
    const objects = (result.Contents ?? []).flatMap((object) =>
      object.Key === undefined || object.LastModified === undefined
        ? []
        : [{ key: object.Key, lastModified: object.LastModified, sizeBytes: object.Size ?? 0 }],
    );
    return {
      ...(result.IsTruncated === true && result.NextContinuationToken !== undefined
        ? { continuationToken: result.NextContinuationToken }
        : {}),
      objects,
    };
  }

  public async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
  }

  public close(): void {
    this.client.destroy();
  }
}
