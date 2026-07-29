import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type QueryResultRow } from "pg";
import { safeErrorCategory } from "../core/error-telemetry.js";
import {
  parseAttachmentUploadOrigins,
  uploadLocalAttachments,
} from "../cli-send-attachments.js";
import { HAYASEND_VERSION } from "../version.js";
import {
  advanceDueRow,
  assertEmptyBaseline,
  assertFinalFixture,
  assertInitialFixture,
  authorization,
  baselineCounts,
  cleanupFixture,
  databaseMajorVersion,
  delayedJobCount,
  deliveryFixture,
  finalFixture,
  healthCheck,
  parseEntity,
  responseJson,
  type Fetcher,
  waitForSent,
} from "./hosted-proof.js";

const PROOF_CONFIRMATION = "isolated-backup-restore-proof";
const RETAIN_CONFIRMATION = "retain-isolated-backup-fixture";
const EMAIL_ID_PATTERN = /^email_[a-f0-9]{32}$/;
const ATTACHMENT_ID_PATTERN = /^att_[a-f0-9]{32}$/;
const OUTBOX_ID_PATTERN =
  /^outbox:v1:email_[a-f0-9]{32}:dispatch-message:[0-9]+$/;
const RUN_ID_PATTERN = /^restore_[a-f0-9]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MINIMUM_SCHEDULE_DAYS = 8;
const MAXIMUM_SCHEDULE_DAYS = 30;
const DEFAULT_SCHEDULE_DAYS = 30;
const DEFAULT_TIMEOUT_SECONDS = 120;

interface ApiEmail {
  id?: unknown;
  status?: unknown;
}

interface AttachmentRecord {
  id?: unknown;
  filename?: unknown;
  content_type?: unknown;
  size_bytes?: unknown;
  checksum_sha256?: unknown;
  object_key?: unknown;
}

interface AttachmentReference {
  attachment_id?: unknown;
  filename?: unknown;
  content_type?: unknown;
  size_bytes?: unknown;
  checksum_sha256?: unknown;
  object_key?: unknown;
}

interface EmailEntity {
  id?: unknown;
  status?: unknown;
  scheduled_at?: unknown;
  attachments?: unknown;
}

interface MessageEntity {
  id?: unknown;
  status?: unknown;
  scheduled_at?: unknown;
  provider?: {
    name?: unknown;
  };
}

interface OutboxEntity {
  id?: unknown;
  due_at?: unknown;
  dispatched_at?: unknown;
}

interface BackupFixtureRow extends QueryResultRow {
  email_entity: unknown;
  message_entity: unknown;
  outbox_entity: unknown;
  outbox_id: string;
  due_at: Date;
  dispatched_at: Date | null;
  recipient_count: string;
  idempotency_count: string;
  attachment_entity: unknown;
}

interface AttachmentRemainingRow extends QueryResultRow {
  total: string;
}

interface BackupFixtureSnapshot {
  email: {
    id: string;
    status: "scheduled";
    scheduled_at: string;
    attachment: SanitizedAttachment;
  };
  message: {
    id: string;
    status: "scheduled";
    scheduled_at: string;
    provider: "portable-console";
  };
  outbox: {
    id: string;
    due_at: string;
    dispatched: false;
  };
  counts: {
    recipients: 1;
    idempotency_claims: 1;
    delayed_jobs: 1;
  };
}

interface SanitizedAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  object_key: string;
}

export interface PortableBackupRestoreSeedOptions {
  api_url: string;
  api_key: string;
  database_url: string;
  confirmation: string;
  retain_confirmation: string;
  transport: string;
  schedule_days?: number | undefined;
  run_id?: string | undefined;
  allowed_upload_origins?: ReadonlySet<string> | undefined;
  attachment_content?: Uint8Array | undefined;
  fetch?: Fetcher | undefined;
  now?: (() => Date) | undefined;
  allow_test_http?: boolean | undefined;
}

export interface PortableBackupRestoreSeedEvidence {
  object: "portable_backup_restore_seed_proof";
  schema_version: "1.0.0";
  hayasend_version: string;
  run_id: string;
  created_at: string;
  api_origin_sha256: string;
  database: {
    engine: "postgresql";
    major_version: number;
    connection_verified: true;
  };
  transport: "portable-console";
  fixture: {
    email_id: string;
    outbox_id: string;
    attachment_id: string;
    scheduled_at: string;
    state_sha256: string;
    attachment_sha256: string;
    attachment_size_bytes: number;
  };
  checks: {
    health: true;
    readiness: true;
    isolated_empty_database: true;
    atomic_scheduled_fixture: true;
    idempotency_replay: true;
    schedule_exceeds_seven_days: true;
    durable_delayed_job_present: true;
    attachment_direct_upload: true;
    attachment_checksum_bound: true;
    retained_for_isolated_backup: true;
    external_send_performed: false;
  };
  privacy: PrivacyEvidence;
}

export interface PortableBackupRestoreVerifyOptions {
  api_url: string;
  api_key: string;
  database_url: string;
  confirmation: string;
  transport: string;
  source: PortableBackupRestoreSeedEvidence;
  timeout_seconds?: number | undefined;
  fetch?: Fetcher | undefined;
  now?: (() => Date) | undefined;
  wait?: ((milliseconds: number) => Promise<void>) | undefined;
  after_due_advance?: (() => void | Promise<void>) | undefined;
  allow_test_http?: boolean | undefined;
}

export interface PortableBackupRestoreEvidence {
  object: "portable_backup_restore_proof";
  schema_version: "1.0.0";
  hayasend_version: string;
  run_id: string;
  completed_at: string;
  source_state_sha256: string;
  restored_state_sha256: string;
  api_origin_sha256: string;
  database: {
    engine: "postgresql";
    major_version: number;
    connection_verified: true;
  };
  transport: "portable-console";
  checks: {
    health: true;
    readiness: true;
    restored_state_matches_source: true;
    restored_attachment_reference_matches_source: true;
    restored_attachment_bytes_rehashed_by_runtime: true;
    lost_wakeup_jobs_removed: number;
    authoritative_due_row_advanced: true;
    periodic_sweeper_recovered: true;
    email_state: "sent";
    message_state: "accepted";
    provider_attempt_state: "accepted";
    provider_acceptance_only: true;
    terminal_delivery_claimed: false;
    external_send_performed: false;
  };
  cleanup: {
    database_fixture_rows_remaining: 0;
    complete: true;
    object_cleanup_delegated_to_provider: true;
  };
  privacy: PrivacyEvidence;
}

interface PrivacyEvidence {
  credentials_included: false;
  addresses_included: false;
  content_included: false;
  upload_url_included: false;
  raw_errors_included: false;
}

const PRIVACY_EVIDENCE = {
  credentials_included: false,
  addresses_included: false,
  content_included: false,
  upload_url_included: false,
  raw_errors_included: false,
} as const;

function validateInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
}

function validateOrigin(
  raw: string,
  allowTestHttp: boolean | undefined,
): URL {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(allowTestHttp === true && url.protocol === "http:"))
  ) {
    throw new Error(
      "Backup/restore proof API URL must be a credential-free HTTPS origin.",
    );
  }
  return new URL("/", url);
}

function validateSharedOptions(options: {
  api_url: string;
  api_key: string;
  database_url: string;
  confirmation: string;
  transport: string;
  allow_test_http?: boolean | undefined;
}): URL {
  if (options.confirmation !== PROOF_CONFIRMATION) {
    throw new Error(
      `Set HAYASEND_BACKUP_RESTORE_PROOF_CONFIRM=${PROOF_CONFIRMATION}.`,
    );
  }
  if (options.transport !== "console") {
    throw new Error(
      "The backup/restore proof requires the non-sending console transport.",
    );
  }
  if (!options.api_key || !options.database_url) {
    throw new Error("Backup/restore proof credentials are missing.");
  }
  return validateOrigin(options.api_url, options.allow_test_http);
}

function createRunId(): string {
  return `restore_${randomBytes(8).toString("hex")}`;
}

function defaultAttachmentContent(runId: string): Uint8Array {
  const digest = createHash("sha256")
    .update(`HayaSend isolated backup restore ${runId}`)
    .digest();
  return new Uint8Array(Buffer.concat([digest, digest, digest, digest]));
}

function apiOriginDigest(apiOrigin: URL): string {
  return createHash("sha256").update(apiOrigin.origin).digest("hex");
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function attachmentFromEntity(
  value: unknown,
  expectedId: string,
): SanitizedAttachment {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(
      "Backup/restore proof fixture must contain exactly one attachment.",
    );
  }
  const record = value[0] as AttachmentReference;
  if (
    record.attachment_id !== expectedId ||
    typeof record.filename !== "string" ||
    typeof record.content_type !== "string" ||
    !Number.isSafeInteger(record.size_bytes) ||
    (record.size_bytes as number) < 1 ||
    typeof record.checksum_sha256 !== "string" ||
    !SHA256_PATTERN.test(record.checksum_sha256) ||
    typeof record.object_key !== "string" ||
    record.object_key !== `attachments/${expectedId}/content`
  ) {
    throw new Error(
      "Backup/restore proof attachment metadata does not match its guards.",
    );
  }
  return {
    id: expectedId,
    filename: record.filename,
    content_type: record.content_type,
    size_bytes: record.size_bytes as number,
    checksum_sha256: record.checksum_sha256,
    object_key: record.object_key,
  };
}

async function backupFixture(
  pool: Pool,
  emailId: string,
  outboxId: string,
  attachmentId: string,
): Promise<BackupFixtureRow> {
  const result = await pool.query<BackupFixtureRow>(
    `SELECT
       email.entity AS email_entity,
       message.entity AS message_entity,
       outbox.entity AS outbox_entity,
       outbox.id AS outbox_id,
       outbox.due_at,
       outbox.dispatched_at,
       (
         SELECT count(*)::text
         FROM delivery_recipients
         WHERE message_id = email.id
       ) AS recipient_count,
       (
         SELECT count(*)::text
         FROM idempotency_claims
         WHERE email_id = email.id
       ) AS idempotency_count,
       attachment.entity AS attachment_entity
     FROM emails AS email
     JOIN delivery_messages AS message ON message.id = email.id
     JOIN outbox_items AS outbox ON outbox.message_id = email.id
     JOIN app_entities AS attachment
       ON attachment.kind = 'attachment_upload'
      AND attachment.id = $3
     WHERE email.id = $1 AND outbox.id = $2`,
    [emailId, outboxId, attachmentId],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Backup/restore proof fixture is incomplete.");
  }
  return row;
}

async function fixtureSnapshot(
  pool: Pool,
  emailId: string,
  outboxId: string,
  attachmentId: string,
  scheduledAt: string,
): Promise<BackupFixtureSnapshot> {
  const row = await backupFixture(pool, emailId, outboxId, attachmentId);
  const email = parseEntity<EmailEntity>(row.email_entity);
  const message = parseEntity<MessageEntity>(row.message_entity);
  const outbox = parseEntity<OutboxEntity>(row.outbox_entity);
  const storedAttachment = parseEntity<AttachmentRecord>(
    row.attachment_entity,
  );
  const emailAttachment = attachmentFromEntity(
    email.attachments,
    attachmentId,
  );
  if (
    email.id !== emailId ||
    email.status !== "scheduled" ||
    email.scheduled_at !== scheduledAt ||
    message.id !== emailId ||
    message.status !== "scheduled" ||
    message.scheduled_at !== scheduledAt ||
    message.provider?.name !== "portable-console" ||
    outbox.id !== outboxId ||
    outbox.due_at !== scheduledAt ||
    row.due_at.toISOString() !== scheduledAt ||
    row.dispatched_at !== null ||
    (outbox.dispatched_at !== undefined &&
      outbox.dispatched_at !== null) ||
    row.recipient_count !== "1" ||
    row.idempotency_count !== "1" ||
    storedAttachment.id !== attachmentId ||
    storedAttachment.filename !== emailAttachment.filename ||
    storedAttachment.content_type !== emailAttachment.content_type ||
    storedAttachment.size_bytes !== emailAttachment.size_bytes ||
    storedAttachment.checksum_sha256 !== emailAttachment.checksum_sha256 ||
    storedAttachment.object_key !== emailAttachment.object_key
  ) {
    throw new Error(
      "Backup/restore proof scheduled fixture does not match its guards.",
    );
  }
  if ((await delayedJobCount(pool, emailId, outboxId)) !== 1) {
    throw new Error(
      "Backup/restore proof durable delayed wake-up job is not singular.",
    );
  }
  return {
    email: {
      id: emailId,
      status: "scheduled",
      scheduled_at: scheduledAt,
      attachment: emailAttachment,
    },
    message: {
      id: emailId,
      status: "scheduled",
      scheduled_at: scheduledAt,
      provider: "portable-console",
    },
    outbox: {
      id: outboxId,
      due_at: scheduledAt,
      dispatched: false,
    },
    counts: {
      recipients: 1,
      idempotency_claims: 1,
      delayed_jobs: 1,
    },
  };
}

function snapshotDigest(snapshot: BackupFixtureSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

async function deleteAttachmentMetadata(
  pool: Pool,
  attachmentId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM app_entities
     WHERE kind = 'attachment_upload' AND id = $1`,
    [attachmentId],
  );
  const remaining = await pool.query<AttachmentRemainingRow>(
    `SELECT count(*)::text AS total
     FROM app_entities
     WHERE kind = 'attachment_upload' AND id = $1`,
    [attachmentId],
  );
  if (remaining.rows[0]?.total !== "0") {
    throw new Error(
      "Backup/restore proof attachment metadata cleanup is incomplete.",
    );
  }
}

async function cleanupDatabaseFixture(
  pool: Pool,
  emailId: string,
  outboxId: string,
  attachmentId: string,
): Promise<void> {
  const remaining = await cleanupFixture(pool, emailId, outboxId);
  if (remaining !== 0) {
    throw new Error(
      "Backup/restore proof delivery fixture cleanup is incomplete.",
    );
  }
  await deleteAttachmentMetadata(pool, attachmentId);
}

function validateSource(
  source: PortableBackupRestoreSeedEvidence,
): void {
  if (
    typeof source !== "object" ||
    source === null ||
    typeof source.fixture !== "object" ||
    source.fixture === null ||
    typeof source.checks !== "object" ||
    source.checks === null ||
    source.object !== "portable_backup_restore_seed_proof" ||
    source.schema_version !== "1.0.0" ||
    source.hayasend_version !== HAYASEND_VERSION ||
    !RUN_ID_PATTERN.test(source.run_id) ||
    !EMAIL_ID_PATTERN.test(source.fixture.email_id) ||
    !OUTBOX_ID_PATTERN.test(source.fixture.outbox_id) ||
    !ATTACHMENT_ID_PATTERN.test(source.fixture.attachment_id) ||
    !Number.isFinite(Date.parse(source.fixture.scheduled_at)) ||
    !SHA256_PATTERN.test(source.fixture.state_sha256) ||
    !SHA256_PATTERN.test(source.fixture.attachment_sha256) ||
    !Number.isSafeInteger(source.fixture.attachment_size_bytes) ||
    source.fixture.attachment_size_bytes < 1 ||
    source.transport !== "portable-console" ||
    source.checks.external_send_performed !== false
  ) {
    throw new Error("Backup/restore proof source evidence is invalid.");
  }
}

export async function seedPortableBackupRestoreProof(
  options: PortableBackupRestoreSeedOptions,
): Promise<PortableBackupRestoreSeedEvidence> {
  const apiOrigin = validateSharedOptions(options);
  if (options.retain_confirmation !== RETAIN_CONFIRMATION) {
    throw new Error(
      `Set HAYASEND_BACKUP_RESTORE_RETAIN_CONFIRM=${RETAIN_CONFIRMATION}.`,
    );
  }
  const runId = options.run_id ?? createRunId();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Backup/restore proof run ID is invalid.");
  }
  const scheduleDays = options.schedule_days ?? DEFAULT_SCHEDULE_DAYS;
  validateInteger(
    scheduleDays,
    "Backup/restore proof schedule days",
    MINIMUM_SCHEDULE_DAYS,
    MAXIMUM_SCHEDULE_DAYS,
  );
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const scheduledAt = new Date(
    createdAt.getTime() + scheduleDays * 86_400_000,
  ).toISOString();
  const fetcher = options.fetch ?? fetch;
  const attachmentContent =
    options.attachment_content ?? defaultAttachmentContent(runId);
  if (
    attachmentContent.byteLength < 1 ||
    attachmentContent.byteLength > 1024 * 1024
  ) {
    throw new Error(
      "Backup/restore proof attachment must be between 1 byte and 1 MiB.",
    );
  }
  const attachmentChecksum = createHash("sha256")
    .update(attachmentContent)
    .digest("hex");
  const pool = new Pool({
    connectionString: options.database_url,
    max: 1,
    application_name: "hayasend-backup-restore-seed",
  });
  let emailId: string | undefined;
  let outboxId: string | undefined;
  let attachmentId: string | undefined;
  try {
    const majorVersion = await databaseMajorVersion(pool);
    assertEmptyBaseline(await baselineCounts(pool));
    await healthCheck(fetcher, apiOrigin, "/healthz");
    await healthCheck(fetcher, apiOrigin, "/readyz");
    [attachmentId] = await uploadLocalAttachments(
      [
        {
          filename: "backup-restore-proof.bin",
          contentType: "application/octet-stream",
          content: attachmentContent,
          checksum: attachmentChecksum,
        },
      ],
      {
        baseUrl: apiOrigin.origin,
        fetch: fetcher as typeof fetch,
        allowedUploadOrigins:
          options.allowed_upload_origins ?? new Set<string>(),
        request: (path, init) =>
          responseJson(
            fetcher,
            new URL(path, apiOrigin),
            {
              ...init,
              headers: {
                ...authorization(options.api_key),
                "content-type": "application/json",
              },
            },
          ),
      },
    );
    if (!attachmentId || !ATTACHMENT_ID_PATTERN.test(attachmentId)) {
      throw new Error(
        "Backup/restore proof attachment identity is invalid.",
      );
    }
    const request = {
      method: "POST",
      headers: {
        ...authorization(options.api_key),
        "idempotency-key": `hayasend-${runId}`,
      },
      body: JSON.stringify({
        from: "HayaSend Proof <proof-sender@example.com>",
        to: ["proof-recipient@example.net"],
        subject: `HayaSend backup restore proof ${runId}`,
        text: "Isolated console-only backup and restore proof.",
        scheduled_at: scheduledAt,
        attachments: [{ attachment_id: attachmentId }],
      }),
    } satisfies RequestInit;
    const first = await responseJson<ApiEmail>(
      fetcher,
      new URL("/emails", apiOrigin),
      request,
    );
    if (
      typeof first.id !== "string" ||
      !EMAIL_ID_PATTERN.test(first.id)
    ) {
      throw new Error(
        "Backup/restore proof API did not return an email identity.",
      );
    }
    emailId = first.id;
    const replay = await responseJson<ApiEmail>(
      fetcher,
      new URL("/emails", apiOrigin),
      request,
    );
    if (replay.id !== emailId) {
      throw new Error(
        "Backup/restore proof idempotency replay did not converge.",
      );
    }
    const fixture = await deliveryFixture(pool, emailId);
    outboxId = assertInitialFixture(fixture, emailId, scheduledAt);
    const snapshot = await fixtureSnapshot(
      pool,
      emailId,
      outboxId,
      attachmentId,
      scheduledAt,
    );
    return {
      object: "portable_backup_restore_seed_proof",
      schema_version: "1.0.0",
      hayasend_version: HAYASEND_VERSION,
      run_id: runId,
      created_at: createdAt.toISOString(),
      api_origin_sha256: apiOriginDigest(apiOrigin),
      database: {
        engine: "postgresql",
        major_version: majorVersion,
        connection_verified: true,
      },
      transport: "portable-console",
      fixture: {
        email_id: emailId,
        outbox_id: outboxId,
        attachment_id: attachmentId,
        scheduled_at: scheduledAt,
        state_sha256: snapshotDigest(snapshot),
        attachment_sha256: attachmentChecksum,
        attachment_size_bytes: attachmentContent.byteLength,
      },
      checks: {
        health: true,
        readiness: true,
        isolated_empty_database: true,
        atomic_scheduled_fixture: true,
        idempotency_replay: true,
        schedule_exceeds_seven_days: true,
        durable_delayed_job_present: true,
        attachment_direct_upload: true,
        attachment_checksum_bound: true,
        retained_for_isolated_backup: true,
        external_send_performed: false,
      },
      privacy: PRIVACY_EVIDENCE,
    };
  } catch (error) {
    if (emailId && outboxId && attachmentId) {
      try {
        await cleanupDatabaseFixture(
          pool,
          emailId,
          outboxId,
          attachmentId,
        );
      } catch {
        throw new Error(
          "Backup/restore seed failed and database cleanup also failed.",
          { cause: error },
        );
      }
    } else if (attachmentId) {
      try {
        await deleteAttachmentMetadata(pool, attachmentId);
      } catch {
        throw new Error(
          "Backup/restore seed failed and attachment metadata cleanup also failed.",
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    await pool.end();
  }
}

export async function verifyPortableBackupRestoreProof(
  options: PortableBackupRestoreVerifyOptions,
): Promise<PortableBackupRestoreEvidence> {
  const apiOrigin = validateSharedOptions(options);
  validateSource(options.source);
  const timeoutSeconds =
    options.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  validateInteger(
    timeoutSeconds,
    "Backup/restore proof timeout seconds",
    10,
    900,
  );
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const wait = options.wait ?? waitFor;
  const { email_id: emailId, outbox_id: outboxId } =
    options.source.fixture;
  const attachmentId = options.source.fixture.attachment_id;
  const scheduledAt = options.source.fixture.scheduled_at;
  const pool = new Pool({
    connectionString: options.database_url,
    max: 1,
    application_name: "hayasend-backup-restore-verify",
  });
  let failure: unknown;
  let evidence:
    | Omit<PortableBackupRestoreEvidence, "cleanup">
    | undefined;
  try {
    const majorVersion = await databaseMajorVersion(pool);
    await healthCheck(fetcher, apiOrigin, "/healthz");
    await healthCheck(fetcher, apiOrigin, "/readyz");
    const snapshot = await fixtureSnapshot(
      pool,
      emailId,
      outboxId,
      attachmentId,
      scheduledAt,
    );
    const restoredDigest = snapshotDigest(snapshot);
    if (restoredDigest !== options.source.fixture.state_sha256) {
      throw new Error(
        "Restored backup/restore proof state does not match the source.",
      );
    }
    const restoredAttachment = snapshot.email.attachment;
    if (
      restoredAttachment.checksum_sha256 !==
        options.source.fixture.attachment_sha256 ||
      restoredAttachment.size_bytes !==
        options.source.fixture.attachment_size_bytes
    ) {
      throw new Error(
        "Restored backup/restore attachment reference does not match the source.",
      );
    }
    const client = await pool.connect();
    let lostWakeupJobs: number;
    try {
      const advancedAt = now();
      lostWakeupJobs = await advanceDueRow(
        client,
        emailId,
        outboxId,
        new Date(advancedAt.getTime() - 1_000),
        advancedAt,
      );
    } finally {
      client.release();
    }
    await options.after_due_advance?.();
    await waitForSent(
      fetcher,
      apiOrigin,
      options.api_key,
      emailId,
      timeoutSeconds,
      wait,
    );
    assertFinalFixture(await finalFixture(pool, emailId, outboxId));
    evidence = {
      object: "portable_backup_restore_proof",
      schema_version: "1.0.0",
      hayasend_version: HAYASEND_VERSION,
      run_id: options.source.run_id,
      completed_at: now().toISOString(),
      source_state_sha256: options.source.fixture.state_sha256,
      restored_state_sha256: restoredDigest,
      api_origin_sha256: apiOriginDigest(apiOrigin),
      database: {
        engine: "postgresql",
        major_version: majorVersion,
        connection_verified: true,
      },
      transport: "portable-console",
      checks: {
        health: true,
        readiness: true,
        restored_state_matches_source: true,
        restored_attachment_reference_matches_source: true,
        restored_attachment_bytes_rehashed_by_runtime: true,
        lost_wakeup_jobs_removed: lostWakeupJobs,
        authoritative_due_row_advanced: true,
        periodic_sweeper_recovered: true,
        email_state: "sent",
        message_state: "accepted",
        provider_attempt_state: "accepted",
        provider_acceptance_only: true,
        terminal_delivery_claimed: false,
        external_send_performed: false,
      },
      privacy: PRIVACY_EVIDENCE,
    };
  } catch (error) {
    failure = error;
  }
  try {
    await cleanupDatabaseFixture(
      pool,
      emailId,
      outboxId,
      attachmentId,
    );
  } catch (cleanupError) {
    failure =
      failure === undefined
        ? cleanupError
        : new Error(
            "Backup/restore verification failed and database cleanup also failed.",
            { cause: cleanupError },
          );
  }
  try {
    await pool.end();
  } catch (poolError) {
    failure ??= poolError;
  }
  if (failure) {
    throw failure;
  }
  if (!evidence) {
    throw new Error("Backup/restore proof evidence was not completed.");
  }
  return {
    ...evidence,
    cleanup: {
      database_fixture_rows_remaining: 0,
      complete: true,
      object_cleanup_delegated_to_provider: true,
    },
  };
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Set ${name} for the backup/restore proof.`);
  }
  return value;
}

function optionalInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const value = environment[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

function parseSeedEvidence(
  value: unknown,
): PortableBackupRestoreSeedEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Backup/restore source evidence must be an object.");
  }
  const source = value as PortableBackupRestoreSeedEvidence;
  validateSource(source);
  return source;
}

export async function runPortableBackupRestoreProofProcess(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const mode = requiredEnvironment(
    environment,
    "HAYASEND_BACKUP_RESTORE_PROOF_MODE",
  );
  const common = {
    api_url: requiredEnvironment(
      environment,
      "HAYASEND_HOSTED_PROOF_API_URL",
    ),
    api_key: requiredEnvironment(environment, "HAYASEND_API_KEY"),
    database_url: requiredEnvironment(
      environment,
      "HAYASEND_DATABASE_URL",
    ),
    confirmation: requiredEnvironment(
      environment,
      "HAYASEND_BACKUP_RESTORE_PROOF_CONFIRM",
    ),
    transport: requiredEnvironment(environment, "HAYASEND_TRANSPORT"),
  };
  let evidence: PortableBackupRestoreSeedEvidence | PortableBackupRestoreEvidence;
  if (mode === "seed") {
    evidence = await seedPortableBackupRestoreProof({
      ...common,
      retain_confirmation: requiredEnvironment(
        environment,
        "HAYASEND_BACKUP_RESTORE_RETAIN_CONFIRM",
      ),
      allowed_upload_origins: parseAttachmentUploadOrigins(
        environment.HAYASEND_ATTACHMENT_UPLOAD_ORIGINS,
      ),
      ...(optionalInteger(
        environment,
        "HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS",
      ) !== undefined
        ? {
            schedule_days: optionalInteger(
              environment,
              "HAYASEND_HOSTED_PROOF_SCHEDULE_DAYS",
            ),
          }
        : {}),
    });
  } else if (mode === "restore") {
    const sourceFile = requiredEnvironment(
      environment,
      "HAYASEND_BACKUP_RESTORE_SOURCE_FILE",
    );
    evidence = await verifyPortableBackupRestoreProof({
      ...common,
      source: parseSeedEvidence(
        JSON.parse(await readFile(sourceFile, "utf8")) as unknown,
      ),
      ...(optionalInteger(
        environment,
        "HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS",
      ) !== undefined
        ? {
            timeout_seconds: optionalInteger(
              environment,
              "HAYASEND_HOSTED_PROOF_TIMEOUT_SECONDS",
            ),
          }
        : {}),
    });
  } else {
    throw new Error(
      "HAYASEND_BACKUP_RESTORE_PROOF_MODE must be seed or restore.",
    );
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPortableBackupRestoreProofProcess().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        object: "portable_backup_restore_proof_failure",
        schema_version: "1.0.0",
        error_type: safeErrorCategory(error),
        credentials_included: false,
        addresses_included: false,
        content_included: false,
        upload_url_included: false,
        raw_error_included: false,
      })}\n`,
    );
    process.exitCode = 1;
  });
}
