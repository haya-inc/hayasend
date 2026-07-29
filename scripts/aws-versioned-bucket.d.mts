export interface VersionedBucketOptions {
  account: string;
  region: string;
  bucket: string;
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
