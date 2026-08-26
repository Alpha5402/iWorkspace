import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
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
