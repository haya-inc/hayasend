export interface BackupRestoreProofOptions {
  account: string;
  region: string;
  table: string;
  bucket: string;
  tableArn: string;
  bucketArn: string;
  vaultArn: string;
  vaultName: string;
  restorePlanArn: string;
  restorePlanName: string;
  stateFile: string;
}

export function stableCanonicalJson(value: unknown): string;

export function assertRestoreTestingPlanIdentity(
  plan: {
    RestoreTestingPlanName?: string;
    RestoreTestingPlanArn?: string;
  } | undefined,
  options: BackupRestoreProofOptions,
): {
  RestoreTestingPlanName?: string;
  RestoreTestingPlanArn?: string;
};

export function summarizeDynamoProbe(
  items: Array<Record<string, unknown>>,
  emailId: string,
  attachmentId: string,
): {
  item_count: number;
  digest_sha256: string;
  semantic_counts: Record<string, number>;
};

export function restoredResourceTarget(
  job: Record<string, unknown>,
  options: BackupRestoreProofOptions,
): {
  type: "DynamoDB" | "S3";
  name: string;
  arn: string;
};

export type BackupAwsJsonRunner = (
  args: string[],
) => Promise<Record<string, any>>;

export function cleanupProofResources(
  options: BackupRestoreProofOptions,
  state: Record<string, any>,
  runAwsJson?: BackupAwsJsonRunner,
): Promise<{
  completed_at: string;
  restored_resources_absent: true;
  recovery_points_absent: true;
}>;
