import { type DeliveryDatabase } from '@delivery/database';
import { type ImmutableArtifactStore } from '@delivery/object-storage';

type GarbageCollectionStore = Pick<ImmutableArtifactStore, 'delete' | 'list'>;
export type ArtifactReferenceLookup = (objectKeys: readonly string[]) => Promise<readonly string[]>;

export type ArtifactGarbageCollectionResult = Readonly<{
  deletedArtifactObjects: number;
  deletedTemporaryObjects: number;
  inspectedObjects: number;
}>;

export class ArtifactGarbageCollector {
  private activeRun: Promise<ArtifactGarbageCollectionResult> | null = null;
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly lookupReferencedObjectKeys: ArtifactReferenceLookup,
    private readonly store: GarbageCollectionStore,
    private readonly options: Readonly<{
      intervalMilliseconds: number;
      maximumObjectsPerSweep: number;
      minimumAgeMilliseconds: number;
      now?: () => Date;
      onError?: (error: unknown) => void;
    }>,
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(
      () => void this.runOnce().catch(this.options.onError),
      this.options.intervalMilliseconds,
    );
    this.timer.unref();
  }

  public runOnce(): Promise<ArtifactGarbageCollectionResult> {
    if (this.activeRun !== null) return this.activeRun;
    this.activeRun = this.sweep().finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  public async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.activeRun;
  }

  private async sweep(): Promise<ArtifactGarbageCollectionResult> {
    const cutoff = new Date(
      (this.options.now?.() ?? new Date()).getTime() - this.options.minimumAgeMilliseconds,
    );
    let remaining = this.options.maximumObjectsPerSweep;
    const temporary = await this.collectEligible('tmp/', cutoff, remaining);
    remaining -= temporary.inspected;
    await deleteInBatches(this.store, temporary.keys);

    const artifacts = await this.collectEligible('artifacts/', cutoff, remaining);
    const referenced = new Set<string>();
    for (const keys of chunk(artifacts.keys, 500)) {
      const rows = await this.lookupReferencedObjectKeys(keys);
      for (const objectKey of rows) referenced.add(objectKey);
    }
    const orphaned = artifacts.keys.filter((key) => !referenced.has(key));
    await deleteInBatches(this.store, orphaned);
    return {
      deletedArtifactObjects: orphaned.length,
      deletedTemporaryObjects: temporary.keys.length,
      inspectedObjects: temporary.inspected + artifacts.inspected,
    };
  }

  private async collectEligible(
    prefix: 'artifacts/' | 'tmp/',
    cutoff: Date,
    maximumObjects: number,
  ): Promise<Readonly<{ inspected: number; keys: string[] }>> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    let inspected = 0;
    while (inspected < maximumObjects) {
      const page = await this.store.list(
        prefix,
        continuationToken,
        Math.min(500, maximumObjects - inspected),
      );
      inspected += page.objects.length;
      for (const object of page.objects) {
        if (object.lastModified <= cutoff) keys.push(object.key);
      }
      continuationToken = page.continuationToken;
      if (continuationToken === undefined || page.objects.length === 0) break;
    }
    return { inspected, keys };
  }
}

export function createArtifactReferenceLookup(database: DeliveryDatabase): ArtifactReferenceLookup {
  return async (objectKeys) => {
    if (objectKeys.length === 0) return [];
    return database
      .selectFrom('artifacts')
      .select('object_key')
      .where('object_key', 'in', [...objectKeys])
      .execute()
      .then((rows) => rows.map((row) => row.object_key));
  };
}

async function deleteInBatches(
  store: GarbageCollectionStore,
  keys: readonly string[],
): Promise<void> {
  for (const keysBatch of chunk(keys, 10))
    await Promise.all(keysBatch.map((key) => store.delete(key)));
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
