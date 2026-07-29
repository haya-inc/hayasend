import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { purgeVersionedBucket } from "./aws-versioned-bucket.mjs";

const execFileAsync = promisify(execFile);
const BACKUP_TIMEOUT_MS = 120 * 60 * 1_000;
const RESTORE_TIMEOUT_MS = 150 * 60 * 1_000;
const POLL_INTERVAL_MS = 30_000;
const TERMINAL_BACKUP_FAILURES = new Set([
  "ABORTED",
  "EXPIRED",
  "FAILED",
  "PARTIAL",
]);
const TERMINAL_RESTORE_FAILURES = new Set(["ABORTED", "FAILED"]);

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseOptions(argv) {
  const command = argv[0];
  if (!["prove", "cleanup"].includes(command)) {
    throw new Error(
      "Usage: aws-backup-restore-proof.mjs <prove|cleanup> [options]",
    );
  }
  const options = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("Every option requires one value.");
    }
    if (options.has(name)) {
      throw new Error(`${name} may only be provided once.`);
    }
    options.set(name, value);
  }
  const allowed = new Set([
    "--account",
    "--region",
    "--table",
    "--bucket",
    "--vault-arn",
    "--restore-plan-arn",
    "--restore-plan-name",
    "--state-file",
    "--backup-role-arn",
    "--email-id",
    "--attachment-id",
    "--attachment-sha256",
  ]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unsupported option: ${name}`);
    }
  }
  const parsed = {
    command,
    account: requiredOption(options, "--account"),
    region: requiredOption(options, "--region"),
    table: requiredOption(options, "--table"),
    bucket: requiredOption(options, "--bucket"),
    vaultArn: requiredOption(options, "--vault-arn"),
    restorePlanArn: requiredOption(options, "--restore-plan-arn"),
    restorePlanName: requiredOption(options, "--restore-plan-name"),
    stateFile: requiredOption(options, "--state-file"),
    backupRoleArn: options.get("--backup-role-arn"),
    emailId: options.get("--email-id"),
    attachmentId: options.get("--attachment-id"),
    attachmentSha256: options.get("--attachment-sha256"),
  };
  validateOptions(parsed);
  return parsed;
}

function validateOptions(options) {
  if (!/^\d{12}$/.test(options.account)) {
    throw new Error("--account must be a 12-digit AWS account ID.");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(options.region)) {
    throw new Error("--region must be an exact AWS region.");
  }
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(options.table)) {
    throw new Error("--table must be an exact DynamoDB table name.");
  }
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
    options.bucket.includes("..")
  ) {
    throw new Error("--bucket must be an exact valid S3 bucket name.");
  }
  const backupPrefix = `arn:aws:backup:${options.region}:${options.account}:`;
  if (!options.vaultArn.startsWith(`${backupPrefix}backup-vault:`)) {
    throw new Error("--vault-arn must belong to the exact account and region.");
  }
  if (
    !options.restorePlanArn.startsWith(`${backupPrefix}restore-testing-plan:`)
  ) {
    throw new Error(
      "--restore-plan-arn must belong to the exact account and region.",
    );
  }
  if (!/^[A-Za-z0-9_]{1,50}$/.test(options.restorePlanName)) {
    throw new Error("--restore-plan-name must be an exact valid plan name.");
  }
  if (!isAbsolute(options.stateFile)) {
    throw new Error("--state-file must be an absolute path.");
  }
  if (options.command === "prove") {
    if (
      !options.backupRoleArn?.startsWith(
        `arn:aws:iam::${options.account}:role/`,
      )
    ) {
      throw new Error(
        "--backup-role-arn must belong to the exact AWS account.",
      );
    }
    if (!/^email_[A-Za-z0-9_-]{16,128}$/.test(options.emailId ?? "")) {
      throw new Error("--email-id is invalid.");
    }
    if (!/^att_[a-f0-9]{32}$/.test(options.attachmentId ?? "")) {
      throw new Error("--attachment-id is invalid.");
    }
    if (!/^[a-f0-9]{64}$/.test(options.attachmentSha256 ?? "")) {
      throw new Error("--attachment-sha256 is invalid.");
    }
  }
}

export function stableCanonicalJson(value) {
  function normalize(entry, parentKey) {
    if (Array.isArray(entry)) {
      const values = entry.map((value) => normalize(value));
      return ["SS", "NS", "BS"].includes(parentKey)
        ? values.sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          )
        : values;
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize(entry[key], key)]),
      );
    }
    return entry;
  }
  return JSON.stringify(normalize(value));
}

function digest(value) {
  return createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
}

function attributeString(item, name) {
  const value = item?.[name]?.S;
  return typeof value === "string" ? value : undefined;
}

function canonicalItems(items) {
  return [...items].sort((left, right) => {
    const leftKey = `${attributeString(left, "PK") ?? ""}\0${
      attributeString(left, "SK") ?? ""
    }`;
    const rightKey = `${attributeString(right, "PK") ?? ""}\0${
      attributeString(right, "SK") ?? ""
    }`;
    return leftKey.localeCompare(rightKey);
  });
}

export function summarizeDynamoProbe(items, emailId, attachmentId) {
  const emailPartition = `EMAIL#${emailId}`;
  const outboxKey = `OUTBOX#outbox:v1:${emailId}:dispatch-message:0`;
  const matching = {
    email: items.filter(
      (item) =>
        attributeString(item, "PK") === emailPartition &&
        attributeString(item, "SK") === emailPartition,
    ),
    delivery_message: items.filter(
      (item) =>
        attributeString(item, "PK") === emailPartition &&
        attributeString(item, "SK") === `DELIVERY_MESSAGE#${emailId}`,
    ),
    recipients: items.filter(
      (item) =>
        attributeString(item, "PK") === emailPartition &&
        (attributeString(item, "SK") ?? "").startsWith("RECIPIENT#"),
    ),
    outbox: items.filter(
      (item) =>
        attributeString(item, "PK") === outboxKey &&
        attributeString(item, "SK") === outboxKey,
    ),
    idempotency: items.filter(
      (item) =>
        (attributeString(item, "PK") ?? "").startsWith("IDEMPOTENCY#") &&
        attributeString(item, "email_id") === emailId,
    ),
    attachment: items.filter(
      (item) =>
        attributeString(item, "PK") === `ATTACHMENT#${attachmentId}` &&
        attributeString(item, "SK") === `ATTACHMENT#${attachmentId}`,
    ),
  };
  const counts = Object.fromEntries(
    Object.entries(matching).map(([name, values]) => [name, values.length]),
  );
  if (
    counts.email !== 1 ||
    counts.delivery_message !== 1 ||
    counts.recipients !== 2 ||
    counts.outbox !== 1 ||
    counts.idempotency !== 1 ||
    counts.attachment !== 1
  ) {
    throw new Error(
      `The source ledger is missing required recovery semantics: ${JSON.stringify(
        counts,
      )}`,
    );
  }
  const dispatchedAt = matching.outbox[0]?.entity?.M?.dispatched_at?.S;
  if (typeof dispatchedAt !== "string") {
    throw new Error("The durable outbox was not acknowledged before backup.");
  }
  const ordered = canonicalItems(items);
  return {
    item_count: ordered.length,
    digest_sha256: digest(ordered),
    semantic_counts: counts,
  };
}

export function restoredResourceTarget(job, options) {
  if (!job || typeof job !== "object") {
    throw new Error("AWS Backup returned an invalid restore job.");
  }
  if (job.SourceResourceArn === options.tableArn) {
    const prefix = `arn:aws:dynamodb:${options.region}:${options.account}:table/`;
    if (
      typeof job.CreatedResourceArn !== "string" ||
      !job.CreatedResourceArn.startsWith(prefix)
    ) {
      throw new Error(
        "The restored DynamoDB ARN is outside the exact account.",
      );
    }
    const name = job.CreatedResourceArn.slice(prefix.length);
    if (!name || name.includes("/")) {
      throw new Error("The restored DynamoDB table name is invalid.");
    }
    return { type: "DynamoDB", name, arn: job.CreatedResourceArn };
  }
  if (job.SourceResourceArn === options.bucketArn) {
    const prefix = "arn:aws:s3:::";
    if (
      typeof job.CreatedResourceArn !== "string" ||
      !job.CreatedResourceArn.startsWith(prefix)
    ) {
      throw new Error("The restored S3 ARN is invalid.");
    }
    const name = job.CreatedResourceArn.slice(prefix.length);
    if (
      !name.startsWith("awsbackup-restore-test-") ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) ||
      name === options.bucket
    ) {
      throw new Error("The restored S3 bucket is not an isolated test bucket.");
    }
    return { type: "S3", name, arn: job.CreatedResourceArn };
  }
  throw new Error(
    "The restore job does not belong to an exact source resource.",
  );
}

export async function defaultAwsJsonRunner(args) {
  const { stdout } = await execFileAsync(
    "aws",
    [...args, "--output", "json", "--no-cli-pager"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  return stdout.trim() ? JSON.parse(stdout) : {};
}

async function defaultS3ObjectReader({ bucket, key, region }) {
  const directory = await mkdtemp(join(tmpdir(), "hayasend-restore-object-"));
  const target = join(directory, "object");
  try {
    await execFileAsync(
      "aws",
      [
        "s3api",
        "get-object",
        "--bucket",
        bucket,
        "--key",
        key,
        "--region",
        region,
        target,
        "--output",
        "json",
        "--no-cli-pager",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    return await readFile(target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function persistState(path, state) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyIdentity(options, runAwsJson) {
  const identity = await runAwsJson(["sts", "get-caller-identity"]);
  if (identity.Account !== options.account) {
    throw new Error(
      `Authenticated AWS account ${String(identity.Account)} does not match ${options.account}.`,
    );
  }
}

async function scanTable(table, region, runAwsJson) {
  const result = await runAwsJson([
    "dynamodb",
    "scan",
    "--table-name",
    table,
    "--region",
    region,
    "--consistent-read",
  ]);
  if (!Array.isArray(result.Items)) {
    throw new Error("DynamoDB scan returned no Items array.");
  }
  return result.Items;
}

async function captureS3Probe(bucket, key, region, runAwsJson, readS3Object) {
  const head = await runAwsJson([
    "s3api",
    "head-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--region",
    region,
    "--checksum-mode",
    "ENABLED",
  ]);
  const content = await readS3Object({ bucket, key, region });
  return {
    contentLength: head.ContentLength,
    contentType: head.ContentType,
    metadata: head.Metadata ?? {},
    checksumSHA256: createHash("sha256").update(content).digest("hex"),
  };
}

async function waitForBackupJob(jobId, region, runAwsJson) {
  const deadline = Date.now() + BACKUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await runAwsJson([
      "backup",
      "describe-backup-job",
      "--backup-job-id",
      jobId,
      "--region",
      region,
    ]);
    if (job.State === "COMPLETED") {
      if (typeof job.RecoveryPointArn !== "string") {
        throw new Error(
          `Backup job ${jobId} completed without a recovery point.`,
        );
      }
      return job;
    }
    if (TERMINAL_BACKUP_FAILURES.has(job.State)) {
      throw new Error(`Backup job ${jobId} ended in ${job.State}.`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Backup job ${jobId} exceeded the bounded timeout.`);
}

async function startBackup(
  resourceType,
  resourceArn,
  options,
  state,
  runAwsJson,
) {
  const started = await runAwsJson([
    "backup",
    "start-backup-job",
    "--backup-vault-name",
    options.vaultName,
    "--resource-arn",
    resourceArn,
    "--iam-role-arn",
    options.backupRoleArn,
    "--idempotency-token",
    `hayasend-${resourceType.toLowerCase()}-${Date.now()}`,
    "--start-window-minutes",
    "60",
    "--complete-window-minutes",
    "180",
    "--lifecycle",
    "DeleteAfterDays=1",
    "--region",
    options.region,
  ]);
  if (typeof started.BackupJobId !== "string") {
    throw new Error(`AWS Backup did not return a ${resourceType} job ID.`);
  }
  const record = {
    resource_type: resourceType,
    resource_arn: resourceArn,
    job_id: started.BackupJobId,
  };
  state.backup_jobs.push(record);
  await persistState(options.stateFile, state);
  return record;
}

async function completeBackups(records, options, state, runAwsJson) {
  const completedJobs = await Promise.all(
    records.map((record) =>
      waitForBackupJob(record.job_id, options.region, runAwsJson),
    ),
  );
  for (const [index, record] of records.entries()) {
    const completed = completedJobs[index];
    record.recovery_point_arn = completed.RecoveryPointArn;
    record.creation_date = completed.CreationDate;
    record.completion_date = completed.CompletionDate;
    record.backup_size_bytes = completed.BackupSizeInBytes;
  }
  await persistState(options.stateFile, state);
}

function restoreScheduleExpression(now = new Date()) {
  const scheduled = new Date(now.getTime() + 5 * 60 * 1_000);
  return {
    expression: `cron(${scheduled.getUTCMinutes()} ${scheduled.getUTCHours()} ${scheduled.getUTCDate()} ${
      scheduled.getUTCMonth() + 1
    } ? ${scheduled.getUTCFullYear()})`,
    scheduledAt: scheduled.toISOString(),
  };
}

export function assertRestoreTestingPlanIdentity(plan, options) {
  if (
    plan?.RestoreTestingPlanName !== options.restorePlanName ||
    plan?.RestoreTestingPlanArn !== options.restorePlanArn
  ) {
    throw new Error(
      "The restore testing plan name and ARN do not match exactly.",
    );
  }
  return plan;
}

async function scheduleRestoreTest(options, state, runAwsJson) {
  const current = await runAwsJson([
    "backup",
    "get-restore-testing-plan",
    "--restore-testing-plan-name",
    options.restorePlanName,
    "--region",
    options.region,
  ]);
  const plan = assertRestoreTestingPlanIdentity(
    current.RestoreTestingPlan,
    options,
  );
  const selection = plan.RecoveryPointSelection;
  if (!selection) {
    throw new Error(
      "The restore testing plan has no recovery-point selection.",
    );
  }
  const schedule = restoreScheduleExpression();
  await runAwsJson([
    "backup",
    "update-restore-testing-plan",
    "--restore-testing-plan-name",
    options.restorePlanName,
    "--restore-testing-plan",
    JSON.stringify({
      RecoveryPointSelection: selection,
      ScheduleExpression: schedule.expression,
      ScheduleExpressionTimezone: "UTC",
      StartWindowHours: 1,
    }),
    "--region",
    options.region,
  ]);
  state.restore_schedule = {
    requested_at: new Date().toISOString(),
    scheduled_at: schedule.scheduledAt,
  };
  await persistState(options.stateFile, state);
}

function matchingRestoreJobs(result, options, state) {
  const expectedRecoveryPoints = new Map(
    state.backup_jobs
      .filter((job) => job.recovery_point_arn)
      .map((job) => [job.resource_arn, job.recovery_point_arn]),
  );
  return (result.RestoreJobs ?? []).filter((job) => {
    const expected = expectedRecoveryPoints.get(job.SourceResourceArn);
    return (
      expected !== undefined &&
      job.RecoveryPointArn === expected &&
      job.CreatedBy?.RestoreTestingPlanArn === options.restorePlanArn
    );
  });
}

async function waitForRestoreJobs(options, state, runAwsJson) {
  const deadline = Date.now() + RESTORE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await runAwsJson([
      "backup",
      "list-restore-jobs",
      "--by-restore-testing-plan-arn",
      options.restorePlanArn,
      "--by-created-after",
      state.started_at,
      "--region",
      options.region,
    ]);
    const jobs = matchingRestoreJobs(result, options, state);
    if (jobs.some((job) => TERMINAL_RESTORE_FAILURES.has(job.Status))) {
      const failed = jobs.find((job) =>
        TERMINAL_RESTORE_FAILURES.has(job.Status),
      );
      throw new Error(
        `Restore job ${failed.RestoreJobId} ended in ${failed.Status}.`,
      );
    }
    if (
      jobs.length === 2 &&
      jobs.every(
        (job) =>
          job.Status === "COMPLETED" &&
          typeof job.CreatedResourceArn === "string",
      )
    ) {
      state.restore_jobs = jobs.map((job) => ({
        job_id: job.RestoreJobId,
        resource_type: job.ResourceType,
        source_resource_arn: job.SourceResourceArn,
        recovery_point_arn: job.RecoveryPointArn,
        created_resource_arn: job.CreatedResourceArn,
        creation_date: job.CreationDate,
        completion_date: job.CompletionDate,
      }));
      await persistState(options.stateFile, state);
      return jobs;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Restore testing jobs exceeded the bounded timeout.");
}

function durationSeconds(start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round((endMs - startMs) / 1_000))
    : undefined;
}

async function markRestoreValidation(
  jobs,
  status,
  message,
  options,
  runAwsJson,
) {
  for (const job of jobs) {
    await runAwsJson([
      "backup",
      "put-restore-validation-result",
      "--restore-job-id",
      job.RestoreJobId,
      "--validation-status",
      status,
      "--validation-status-message",
      message,
      "--region",
      options.region,
    ]);
  }
}

async function resourceExists(target, options, runAwsJson) {
  if (target.type === "DynamoDB") {
    try {
      await runAwsJson([
        "dynamodb",
        "describe-table",
        "--table-name",
        target.name,
        "--region",
        options.region,
      ]);
      return true;
    } catch (error) {
      if (
        String(error?.stderr ?? error?.message).includes(
          "ResourceNotFoundException",
        )
      ) {
        return false;
      }
      throw error;
    }
  }
  const buckets = await runAwsJson(["s3api", "list-buckets"]);
  if (!Array.isArray(buckets.Buckets)) {
    throw new Error("S3 ListBuckets returned no Buckets array.");
  }
  return buckets.Buckets.some((bucket) => bucket.Name === target.name);
}

async function deleteRestoredResource(target, options, runAwsJson) {
  if (!(await resourceExists(target, options, runAwsJson))) {
    return;
  }
  if (target.type === "DynamoDB") {
    await runAwsJson([
      "dynamodb",
      "delete-table",
      "--table-name",
      target.name,
      "--region",
      options.region,
    ]);
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (!(await resourceExists(target, options, runAwsJson))) {
        return;
      }
      await sleep(10_000);
    }
    throw new Error(`Restored DynamoDB table ${target.name} still exists.`);
  }
  await purgeVersionedBucket(
    {
      account: options.account,
      region: options.region,
      bucket: target.name,
    },
    runAwsJson,
  );
  await runAwsJson([
    "s3api",
    "delete-bucket",
    "--bucket",
    target.name,
    "--region",
    options.region,
  ]);
  if (await resourceExists(target, options, runAwsJson)) {
    throw new Error(`Restored S3 bucket ${target.name} still exists.`);
  }
}

async function discoverRestoreJobs(options, state, runAwsJson) {
  const result = await runAwsJson([
    "backup",
    "list-restore-jobs",
    "--by-restore-testing-plan-arn",
    options.restorePlanArn,
    "--by-created-after",
    state.started_at,
    "--region",
    options.region,
  ]);
  const sourceArns = new Set([options.tableArn, options.bucketArn]);
  return (result.RestoreJobs ?? []).filter(
    (job) =>
      sourceArns.has(job.SourceResourceArn) &&
      job.CreatedBy?.RestoreTestingPlanArn === options.restorePlanArn,
  );
}

async function deleteRecoveryPoints(options, state, runAwsJson) {
  for (const job of state.backup_jobs ?? []) {
    let current;
    try {
      current = await runAwsJson([
        "backup",
        "describe-backup-job",
        "--backup-job-id",
        job.job_id,
        "--region",
        options.region,
      ]);
    } catch {
      current = undefined;
    }
    if (["CREATED", "PENDING", "RUNNING"].includes(current?.State)) {
      try {
        await runAwsJson([
          "backup",
          "stop-backup-job",
          "--backup-job-id",
          job.job_id,
          "--region",
          options.region,
        ]);
      } catch {
        // A job that reached a terminal state no longer accepts StopBackupJob.
      }
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await runAwsJson([
      "backup",
      "list-recovery-points-by-backup-vault",
      "--backup-vault-name",
      options.vaultName,
      "--by-created-after",
      state.started_at,
      "--region",
      options.region,
    ]);
    const matching = (listed.RecoveryPoints ?? []).filter(
      (point) =>
        [options.tableArn, options.bucketArn].includes(point.ResourceArn) &&
        typeof point.RecoveryPointArn === "string",
    );
    if (matching.length === 0) {
      return;
    }
    for (const point of matching) {
      try {
        await runAwsJson([
          "backup",
          "delete-recovery-point",
          "--backup-vault-name",
          options.vaultName,
          "--recovery-point-arn",
          point.RecoveryPointArn,
          "--region",
          options.region,
        ]);
      } catch {
        // Restore jobs can briefly retain a recovery point after validation.
      }
    }
    await sleep(15_000);
  }
  throw new Error("Recovery points remain in the ephemeral backup vault.");
}

export async function cleanupProofResources(
  options,
  state,
  runAwsJson = defaultAwsJsonRunner,
) {
  await verifyIdentity(options, runAwsJson);
  const jobs = await discoverRestoreJobs(options, state, runAwsJson);
  for (const job of jobs) {
    if (typeof job.CreatedResourceArn !== "string") {
      continue;
    }
    const target = restoredResourceTarget(job, options);
    await deleteRestoredResource(target, options, runAwsJson);
  }
  await deleteRecoveryPoints(options, state, runAwsJson);
  for (const job of jobs) {
    if (typeof job.CreatedResourceArn !== "string") {
      continue;
    }
    const target = restoredResourceTarget(job, options);
    if (await resourceExists(target, options, runAwsJson)) {
      throw new Error(
        `Restored ${target.type} resource remains after cleanup.`,
      );
    }
  }
  state.cleanup = {
    completed_at: new Date().toISOString(),
    restored_resources_absent: true,
    recovery_points_absent: true,
  };
  await persistState(options.stateFile, state);
  return state.cleanup;
}

async function prove(
  options,
  runAwsJson = defaultAwsJsonRunner,
  readS3Object = defaultS3ObjectReader,
) {
  options.tableArn = `arn:aws:dynamodb:${options.region}:${options.account}:table/${options.table}`;
  options.bucketArn = `arn:aws:s3:::${options.bucket}`;
  options.vaultName = options.vaultArn.split(":").at(-1);
  const state = {
    schema_version: 1,
    started_at: new Date().toISOString(),
    account: options.account,
    region: options.region,
    source_resources: [options.tableArn, options.bucketArn],
    backup_jobs: [],
    restore_jobs: [],
  };
  await persistState(options.stateFile, state);
  await verifyIdentity(options, runAwsJson);

  const described = await runAwsJson([
    "dynamodb",
    "describe-table",
    "--table-name",
    options.table,
    "--region",
    options.region,
  ]);
  if (described.Table?.TableArn !== options.tableArn) {
    throw new Error("The source DynamoDB table ARN does not match exactly.");
  }

  const sourceItems = await scanTable(
    options.table,
    options.region,
    runAwsJson,
  );
  const sourceDynamo = summarizeDynamoProbe(
    sourceItems,
    options.emailId,
    options.attachmentId,
  );
  const objectKey = `attachments/${options.attachmentId}/content`;
  const sourceS3 = await captureS3Probe(
    options.bucket,
    objectKey,
    options.region,
    runAwsJson,
    readS3Object,
  );
  if (sourceS3.checksumSHA256 !== options.attachmentSha256) {
    throw new Error(
      "The source attachment checksum does not match the API probe.",
    );
  }

  let restoreJobs = [];
  let cleanup;
  try {
    const dynamoBackup = await startBackup(
      "DynamoDB",
      options.tableArn,
      options,
      state,
      runAwsJson,
    );
    const s3Backup = await startBackup(
      "S3",
      options.bucketArn,
      options,
      state,
      runAwsJson,
    );
    await completeBackups([dynamoBackup, s3Backup], options, state, runAwsJson);
    await scheduleRestoreTest(options, state, runAwsJson);
    restoreJobs = await waitForRestoreJobs(options, state, runAwsJson);

    const dynamoJob = restoreJobs.find(
      (job) => job.SourceResourceArn === options.tableArn,
    );
    const s3Job = restoreJobs.find(
      (job) => job.SourceResourceArn === options.bucketArn,
    );
    const dynamoTarget = restoredResourceTarget(dynamoJob, options);
    const s3Target = restoredResourceTarget(s3Job, options);
    const restoredItems = await scanTable(
      dynamoTarget.name,
      options.region,
      runAwsJson,
    );
    const restoredDynamo = summarizeDynamoProbe(
      restoredItems,
      options.emailId,
      options.attachmentId,
    );
    if (
      stableCanonicalJson(restoredDynamo) !== stableCanonicalJson(sourceDynamo)
    ) {
      throw new Error("The restored DynamoDB ledger differs from the source.");
    }
    const restoredS3 = await captureS3Probe(
      s3Target.name,
      objectKey,
      options.region,
      runAwsJson,
      readS3Object,
    );
    if (stableCanonicalJson(restoredS3) !== stableCanonicalJson(sourceS3)) {
      throw new Error("The restored attachment differs from the source.");
    }
    await markRestoreValidation(
      restoreJobs,
      "SUCCESSFUL",
      "HayaSend semantic data verification passed.",
      options,
      runAwsJson,
    );
    state.validation = {
      status: "SUCCESSFUL",
      dynamodb: sourceDynamo,
      s3: {
        checksum_sha256: sourceS3.checksumSHA256,
        content_length: sourceS3.contentLength,
      },
    };
    await persistState(options.stateFile, state);
  } catch (error) {
    if (restoreJobs.length > 0) {
      try {
        await markRestoreValidation(
          restoreJobs.filter((job) => job.Status === "COMPLETED"),
          "FAILED",
          "HayaSend semantic data verification failed.",
          options,
          runAwsJson,
        );
      } catch {
        // Preserve the original verification failure.
      }
    }
    throw error;
  } finally {
    cleanup = await cleanupProofResources(options, state, runAwsJson);
  }

  return {
    ok: true,
    object: "aws_backup_restore_proof",
    source: {
      dynamodb_item_count: sourceDynamo.item_count,
      dynamodb_digest_sha256: sourceDynamo.digest_sha256,
      semantic_counts: sourceDynamo.semantic_counts,
      attachment_sha256: sourceS3.checksumSHA256,
    },
    backup_jobs: state.backup_jobs.map((job) => ({
      resource_type: job.resource_type,
      job_id: job.job_id,
      recovery_point_arn: job.recovery_point_arn,
      duration_seconds: durationSeconds(job.creation_date, job.completion_date),
    })),
    restore_jobs: state.restore_jobs.map((job) => ({
      resource_type: job.resource_type,
      job_id: job.job_id,
      recovery_point_arn: job.recovery_point_arn,
      duration_seconds: durationSeconds(job.creation_date, job.completion_date),
      validation_status: "SUCCESSFUL",
    })),
    cleanup,
  };
}

function enrichCleanupOptions(options, state) {
  return {
    ...options,
    tableArn: `arn:aws:dynamodb:${options.region}:${options.account}:table/${options.table}`,
    bucketArn: `arn:aws:s3:::${options.bucket}`,
    vaultName: options.vaultArn.split(":").at(-1),
    stateFile: options.stateFile,
    startedAt: state.started_at,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "prove") {
    const result = await prove(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const state = await loadState(options.stateFile);
  if (!state) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, object: "aws_backup_restore_cleanup", skipped: true })}\n`,
    );
    return;
  }
  const cleanup = await cleanupProofResources(
    enrichCleanupOptions(options, state),
    state,
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, object: "aws_backup_restore_cleanup", ...cleanup })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Backup restore proof failed.",
    );
    process.exitCode = 1;
  });
}
