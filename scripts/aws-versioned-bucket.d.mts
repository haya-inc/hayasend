export interface VersionedBucketOptions {
  account: string;
  region: string;
  bucket: string;
  prefix?: string;
}

export type AwsJsonRunner = (
  args: string[],
) => Promise<Record<string, unknown>>;

export function parseVersionedBucketArgs(
  argv: string[],
): VersionedBucketOptions;

export function purgeVersionedBucket(
  options: VersionedBucketOptions,
  runAwsJson?: AwsJsonRunner,
): Promise<{
  ok: true;
  bucket: string;
  deleted_versions: number;
}>;
