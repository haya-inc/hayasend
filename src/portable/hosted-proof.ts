import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Pool,
  type PoolClient,
  type QueryResultRow,
} from "pg";
import { CONSOLE_PROOF_CONFIRMATION } from "../config.js";
import { safeErrorCategory } from "../core/error-telemetry.js";
import { HAYASEND_VERSION } from "../version.js";

const RETAIN_CONFIRMATION = "retain-isolated-proof-fixture";
const EMAIL_ID_PATTERN = /^email_[a-f0-9]{32}$/;
const OUTBOX_ID_PATTERN =
  /^outbox:v1:email_[a-f0-9]{32}:dispatch-message:[0-9]+$/;
const RUN_ID_PATTERN = /^proof_[a-f0-9]{16}$/;
const MINIMUM_SCHEDULE_DAYS = 8;
const MAXIMUM_SCHEDULE_DAYS = 30;
const DEFAULT_SCHEDULE_DAYS = 30;
const DEFAULT_TIMEOUT_SECONDS = 120;

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CountRow extends QueryResultRow {
  emails: string;
  messages: string;
  recipients: string;
  attempts: string;
  events: string;
  idempotency: string;
  outbox: string;
  entities: string;
  aliases: string;
  inbound_claims: string;
  jobs: string;
}

interface DatabaseIdentityRow extends QueryResultRow {
  server_version_num: string;
}

export interface DeliveryFixtureRow extends QueryResultRow {
  email_entity: unknown;
  message_entity: unknown;
  outbox_entity: unknown;
  outbox_id: string;
  due_at: Date;
  dispatched_at: Date | null;
  recipient_count: string;
  idempotency_count: string;
}

export interface FinalFixtureRow extends QueryResultRow {
  email_entity: unknown;
  message_entity: unknown;
  outbox_entity: unknown;
  outbox_id: string;
  dispatched_at: Date | null;
  recipient_entity: unknown;
  attempt_entity: unknown;
  attempt_count: string;
  provider_event_count: string;
  completed_job_count: string;
}

interface RemainingFixtureRow extends QueryResultRow {
  emails: string;
  messages: string;
  recipients: string;
  attempts: string;
  events: string;
  idempotency: string;
  outbox: string;
  jobs: string;
}

interface ApiEmail {
  id?: unknown;
  status?: unknown;
  scheduled_at?: unknown;
}

interface HealthResponse {
  ok?: unknown;
  service?: unknown;
  version?: unknown;
}

interface DeliveryEntity {
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

interface AttemptEntity {
  status?: unknown;
  provider?: {
    name?: unknown;
  };
}

interface RecipientEntity {
  status?: unknown;
}

export interface PortableHostedProofOptions {
  api_url: string;
  api_key: string;
  database_url: string;
  confirmation: string;
  transport: string;
  schedule_days?: number | undefined;
  timeout_seconds?: number | undefined;
  retain_fixture?: boolean | undefined;
  retain_confirmation?: string | undefined;
  run_id?: string | undefined;
  fetch?: Fetcher | undefined;
  now?: (() => Date) | undefined;
  wait?: ((milliseconds: number) => Promise<void>) | undefined;
  after_due_advance?: (() => void | Promise<void>) | undefined;
  allow_test_http?: boolean | undefined;
}

export interface PortableHostedProofEvidence {
  object: "portable_hosted_semantic_proof";
  schema_version: "1.0.0";
  hayasend_version: string;
  run_id: string;
  started_at: string;
  completed_at: string;
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
    exact_runtime_version: true;
    isolated_empty_database: true;
    atomic_delivery_commit: true;
    idempotency_replay: true;
    scheduled_horizon_seconds: number;
    schedule_exceeds_seven_days: true;
    durable_delayed_job_present: true;
    lost_wakeup_jobs_removed: number;
    authoritative_due_row_advanced: true;
    periodic_sweeper_recovered: true;
    email_state: "sent";
    message_state: "accepted";
    recipient_state: "accepted";
    provider_attempt_state: "accepted";
    provider_acceptance_only: true;
    terminal_delivery_claimed: false;
    external_send_performed: false;
    provider_events_observed: 0;
  };
  fixture: {
    email_id: string;
    outbox_id: string;
  };
  cleanup:
    | {
        retained_by_explicit_operator_request: true;
      }
    | {
        retained_by_explicit_operator_request: false;
        fixture_rows_remaining: 0;
        complete: true;
      };
  privacy: {
    credentials_included: false;
    addresses_included: false;
    content_included: false;
    raw_errors_included: false;
  };
}

export function parseEntity<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  if (value === null || typeof value !== "object") {
    throw new Error("Hosted proof database entity is invalid.");
  }
  return value as T;
}

export function integer(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Hosted proof ${name} count is invalid.`);
  }
  return parsed;
}

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

function validateOptions(options: PortableHostedProofOptions): URL {
  if (options.confirmation !== CONSOLE_PROOF_CONFIRMATION) {
    throw new Error(
      `Set HAYASEND_CONSOLE_PROOF_CONFIRM=${CONSOLE_PROOF_CONFIRMATION}.`,
    );
  }
  if (options.transport !== "console") {
    throw new Error(
      "The hosted semantic proof requires the non-sending console transport.",
    );
  }
  if (!options.api_key || !options.database_url) {
    throw new Error("Hosted proof credentials are missing.");
  }
  const apiUrl = new URL(options.api_url);
  if (
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash ||
    (apiUrl.protocol !== "https:" &&
      !(options.allow_test_http === true && apiUrl.protocol === "http:"))
  ) {
    throw new Error(
      "Hosted proof API URL must be a credential-free HTTPS origin.",
    );
  }
  if (
    options.retain_fixture === true &&
    options.retain_confirmation !== RETAIN_CONFIRMATION
  ) {
    throw new Error(
      `Retaining the fixture requires ${RETAIN_CONFIRMATION}.`,
    );
  }
  if (options.run_id && !RUN_ID_PATTERN.test(options.run_id)) {
    throw new Error("Hosted proof run ID is invalid.");
  }
  validateInteger(
    options.schedule_days ?? DEFAULT_SCHEDULE_DAYS,
    "Hosted proof schedule days",
    MINIMUM_SCHEDULE_DAYS,
    MAXIMUM_SCHEDULE_DAYS,
  );
  validateInteger(
    options.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    "Hosted proof timeout seconds",
    10,
    900,
  );
  return new URL("/", apiUrl);
}

export async function responseJson<T>(
  fetcher: Fetcher,
  url: URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetcher(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Hosted proof API request failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function healthCheck(
  fetcher: Fetcher,
  apiOrigin: URL,
  path: "/healthz" | "/readyz",
): Promise<void> {
  const health = await responseJson<HealthResponse>(
    fetcher,
    new URL(path, apiOrigin),
  );
  if (
    health.ok !== true ||
    health.service !== "hayasend" ||
    health.version !== HAYASEND_VERSION
  ) {
    throw new Error("Hosted proof API health identity does not match.");
  }
}

export function authorization(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

export async function baselineCounts(pool: Pool): Promise<CountRow> {
  const result = await pool.query<CountRow>(
    `SELECT
       (SELECT count(*)::text FROM emails) AS emails,
       (SELECT count(*)::text FROM delivery_messages) AS messages,
       (SELECT count(*)::text FROM delivery_recipients) AS recipients,
       (SELECT count(*)::text FROM delivery_attempts) AS attempts,
       (SELECT count(*)::text FROM provider_events) AS events,
       (SELECT count(*)::text FROM idempotency_claims) AS idempotency,
       (SELECT count(*)::text FROM outbox_items) AS outbox,
       (SELECT count(*)::text FROM app_entities) AS entities,
       (SELECT count(*)::text FROM template_aliases) AS aliases,
       (
         SELECT count(*)::text
         FROM received_email_claims
       ) AS inbound_claims,
       (SELECT count(*)::text FROM jobs) AS jobs`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Hosted proof baseline query returned no result.");
  }
  return row;
}

export async function databaseMajorVersion(pool: Pool): Promise<number> {
  const result = await pool.query<DatabaseIdentityRow>(
    "SELECT current_setting('server_version_num') AS server_version_num",
  );
  const identity = result.rows[0];
  if (!identity) {
    throw new Error("Hosted proof database connection check failed.");
  }
  const versionNumber = Number(identity.server_version_num);
  const majorVersion = Math.floor(versionNumber / 10_000);
  if (!Number.isSafeInteger(majorVersion) || majorVersion < 17) {
    throw new Error("Hosted proof requires PostgreSQL 17 or later.");
  }
  return majorVersion;
}

export function assertEmptyBaseline(row: CountRow): void {
  for (const [name, value] of Object.entries(row)) {
    if (integer(value, name) !== 0) {
      throw new Error(
        "Hosted proof requires an empty isolated application database.",
      );
    }
  }
}

export async function deliveryFixture(
  pool: Pool,
  emailId: string,
): Promise<DeliveryFixtureRow> {
  const result = await pool.query<DeliveryFixtureRow>(
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
       ) AS idempotency_count
     FROM emails AS email
     JOIN delivery_messages AS message ON message.id = email.id
     JOIN outbox_items AS outbox ON outbox.message_id = email.id
     WHERE email.id = $1`,
    [emailId],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Hosted proof atomic delivery fixture is incomplete.");
  }
  return row;
}

export async function delayedJobCount(
  pool: Pool,
  emailId: string,
  outboxId: string,
): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total
     FROM jobs
     WHERE completed_at IS NULL
       AND failed_at IS NULL
       AND available_at > now()
       AND (
         envelope->'job'->>'email_id' = $1
         OR envelope->'job'->>'outbox_id' = $2
       )`,
    [emailId, outboxId],
  );
  return integer(result.rows[0]?.total, "delayed job");
}

export async function advanceDueRow(
  client: PoolClient,
  emailId: string,
  outboxId: string,
  dueAt: Date,
  updatedAt: Date,
): Promise<number> {
  await client.query("BEGIN");
  try {
    const locked = await client.query(
      `SELECT email.id
       FROM emails AS email
       JOIN delivery_messages AS message ON message.id = email.id
       JOIN outbox_items AS outbox ON outbox.message_id = email.id
       WHERE email.id = $1
         AND outbox.id = $2
         AND email.entity->>'status' = 'scheduled'
         AND message.entity->>'status' = 'scheduled'
         AND outbox.dispatched_at IS NULL
       FOR UPDATE OF email, message, outbox`,
      [emailId, outboxId],
    );
    if (locked.rowCount !== 1) {
      throw new Error("Hosted proof due-row guard did not match exactly once.");
    }
    const deleted = await client.query(
      `DELETE FROM jobs
       WHERE completed_at IS NULL
         AND failed_at IS NULL
         AND (
           envelope->'job'->>'email_id' = $1
           OR envelope->'job'->>'outbox_id' = $2
         )`,
      [emailId, outboxId],
    );
    if ((deleted.rowCount ?? 0) < 1) {
      throw new Error("Hosted proof found no wake-up job to lose.");
    }
    const email = await client.query(
      `UPDATE emails
       SET entity =
             jsonb_set(
               jsonb_set(
                 entity,
                 '{scheduled_at}',
                 to_jsonb($3::text),
                 false
               ),
               '{updated_at}',
               to_jsonb($4::text),
               false
             ),
           updated_at = $2::timestamptz
       WHERE id = $1
         AND entity->>'status' = 'scheduled'`,
      [
        emailId,
        updatedAt,
        dueAt.toISOString(),
        updatedAt.toISOString(),
      ],
    );
    const message = await client.query(
      `UPDATE delivery_messages
       SET entity =
             jsonb_set(
               jsonb_set(
                 entity,
                 '{scheduled_at}',
                 to_jsonb($3::text),
                 false
               ),
               '{updated_at}',
               to_jsonb($4::text),
               false
             ),
           updated_at = $2::timestamptz
       WHERE id = $1
         AND entity->>'status' = 'scheduled'`,
      [
        emailId,
        updatedAt,
        dueAt.toISOString(),
        updatedAt.toISOString(),
      ],
    );
    const outbox = await client.query(
      `UPDATE outbox_items
       SET due_at = $2::timestamptz,
           lease_owner = NULL,
           lease_expires_at = NULL,
           entity =
             (entity - 'lease_owner' - 'lease_expires_at')
             || jsonb_build_object(
               'due_at', $5::text,
               'updated_at', $6::text
             ),
           updated_at = $3::timestamptz
       WHERE id = $1
         AND message_id = $4
         AND dispatched_at IS NULL`,
      [
        outboxId,
        dueAt,
        updatedAt,
        emailId,
        dueAt.toISOString(),
        updatedAt.toISOString(),
      ],
    );
    if (
      email.rowCount !== 1 ||
      message.rowCount !== 1 ||
      outbox.rowCount !== 1
    ) {
      throw new Error("Hosted proof due-row advance was not atomic.");
    }
    await client.query("COMMIT");
    return deleted.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function waitForSent(
  fetcher: Fetcher,
  apiOrigin: URL,
  apiKey: string,
  emailId: string,
  timeoutSeconds: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const email = await responseJson<ApiEmail>(
      fetcher,
      new URL(`/emails/${emailId}`, apiOrigin),
      { headers: authorization(apiKey) },
    );
    if (email.id !== emailId || typeof email.status !== "string") {
      throw new Error("Hosted proof API email response is invalid.");
    }
    if (email.status === "sent") {
      return;
    }
    if (
      ["failed", "bounced", "complained", "canceled", "suppressed"].includes(
        email.status,
      )
    ) {
      throw new Error("Hosted proof email entered a non-success state.");
    }
    await wait(500);
  }
  throw new Error("Hosted proof timed out waiting for worker recovery.");
}

export async function finalFixture(
  pool: Pool,
  emailId: string,
  outboxId: string,
): Promise<FinalFixtureRow> {
  const result = await pool.query<FinalFixtureRow>(
    `SELECT
       email.entity AS email_entity,
       message.entity AS message_entity,
       outbox.entity AS outbox_entity,
       outbox.id AS outbox_id,
       outbox.dispatched_at,
       recipient.entity AS recipient_entity,
       attempt.entity AS attempt_entity,
       (
         SELECT count(*)::text
         FROM delivery_attempts
         WHERE message_id = email.id
       ) AS attempt_count,
       (
         SELECT count(*)::text
         FROM provider_events
         WHERE message_id = email.id
       ) AS provider_event_count,
       (
         SELECT count(*)::text
         FROM jobs
         WHERE completed_at IS NOT NULL
           AND (
             envelope->'job'->>'email_id' = email.id
             OR envelope->'job'->>'outbox_id' = outbox.id
           )
       ) AS completed_job_count
     FROM emails AS email
     JOIN delivery_messages AS message ON message.id = email.id
     JOIN outbox_items AS outbox ON outbox.message_id = email.id
     JOIN delivery_recipients AS recipient ON recipient.message_id = email.id
     JOIN delivery_attempts AS attempt ON attempt.message_id = email.id
     WHERE email.id = $1 AND outbox.id = $2`,
    [emailId, outboxId],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Hosted proof final delivery fixture is incomplete.");
  }
  return row;
}

export async function cleanupFixture(
  pool: Pool,
  emailId: string,
  outboxId?: string,
): Promise<number> {
  const client = await pool.connect();
  let resolvedOutboxId = outboxId;
  try {
    await client.query("BEGIN");
    if (!resolvedOutboxId) {
      const outbox = await client.query<{ id: string }>(
        "SELECT id FROM outbox_items WHERE message_id = $1 LIMIT 2",
        [emailId],
      );
      if (outbox.rows.length > 1) {
        throw new Error(
          "Hosted proof cleanup found multiple outbox identities.",
        );
      }
      resolvedOutboxId = outbox.rows[0]?.id;
    }
    await client.query(
      `DELETE FROM jobs
       WHERE envelope->'job'->>'email_id' = $1
          OR ($2::text IS NOT NULL AND envelope->'job'->>'outbox_id' = $2)`,
      [emailId, resolvedOutboxId ?? null],
    );
    await client.query("DELETE FROM emails WHERE id = $1", [emailId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const remaining = await pool.query<RemainingFixtureRow>(
    `SELECT
       (SELECT count(*)::text FROM emails WHERE id = $1) AS emails,
       (
         SELECT count(*)::text
         FROM delivery_messages
         WHERE id = $1
       ) AS messages,
       (
         SELECT count(*)::text
         FROM delivery_recipients
         WHERE message_id = $1
       ) AS recipients,
       (
         SELECT count(*)::text
         FROM delivery_attempts
         WHERE message_id = $1
       ) AS attempts,
       (
         SELECT count(*)::text
         FROM provider_events
         WHERE message_id = $1
       ) AS events,
       (
         SELECT count(*)::text
         FROM idempotency_claims
         WHERE email_id = $1
       ) AS idempotency,
       (
         SELECT count(*)::text
         FROM outbox_items
         WHERE message_id = $1
       ) AS outbox,
       (
         SELECT count(*)::text
         FROM jobs
         WHERE envelope->'job'->>'email_id' = $1
            OR ($2::text IS NOT NULL AND envelope->'job'->>'outbox_id' = $2)
       ) AS jobs`,
    [emailId, resolvedOutboxId ?? null],
  );
  const row = remaining.rows[0];
  if (!row) {
    throw new Error("Hosted proof cleanup verification returned no result.");
  }
  return Object.entries(row).reduce(
    (total, [name, value]) => total + integer(value, `remaining ${name}`),
    0,
  );
}

async function discoverFixtureEmailId(
  pool: Pool,
  idempotencyKeyHash: string,
): Promise<string | undefined> {
  const result = await pool.query<{ email_id: string }>(
    `SELECT email_id
     FROM idempotency_claims
     WHERE key_hash = $1`,
    [idempotencyKeyHash],
  );
  const emailId = result.rows[0]?.email_id;
  if (
    result.rows.length > 1 ||
    (emailId !== undefined && !EMAIL_ID_PATTERN.test(emailId))
  ) {
    throw new Error(
      "Hosted proof cleanup could not identify its committed fixture.",
    );
  }
  return emailId;
}

export function assertInitialFixture(
  fixture: DeliveryFixtureRow,
  emailId: string,
  scheduledAt: string,
): string {
  const email = parseEntity<DeliveryEntity>(fixture.email_entity);
  const message = parseEntity<DeliveryEntity>(fixture.message_entity);
  const outbox = parseEntity<OutboxEntity>(fixture.outbox_entity);
  if (
    email.id !== emailId ||
    email.status !== "scheduled" ||
    email.scheduled_at !== scheduledAt ||
    message.id !== emailId ||
    message.status !== "scheduled" ||
    message.scheduled_at !== scheduledAt ||
    message.provider?.name !== "portable-console" ||
    outbox.id !== fixture.outbox_id ||
    outbox.due_at !== scheduledAt ||
    fixture.due_at.toISOString() !== scheduledAt ||
    fixture.dispatched_at !== null ||
    integer(fixture.recipient_count, "recipient") !== 1 ||
    integer(fixture.idempotency_count, "idempotency") !== 1 ||
    !OUTBOX_ID_PATTERN.test(fixture.outbox_id)
  ) {
    throw new Error(
      "Hosted proof atomic scheduled fixture does not match its guards.",
    );
  }
  return fixture.outbox_id;
}

export function assertFinalFixture(fixture: FinalFixtureRow): void {
  const email = parseEntity<DeliveryEntity>(fixture.email_entity);
  const message = parseEntity<DeliveryEntity>(fixture.message_entity);
  const outbox = parseEntity<OutboxEntity>(fixture.outbox_entity);
  const recipient = parseEntity<RecipientEntity>(fixture.recipient_entity);
  const attempt = parseEntity<AttemptEntity>(fixture.attempt_entity);
  if (
    email.status !== "sent" ||
    message.status !== "accepted" ||
    message.provider?.name !== "portable-console" ||
    recipient.status !== "accepted" ||
    attempt.status !== "accepted" ||
    attempt.provider?.name !== "portable-console" ||
    outbox.id !== fixture.outbox_id ||
    typeof outbox.dispatched_at !== "string" ||
    fixture.dispatched_at === null ||
    integer(fixture.attempt_count, "attempt") !== 1 ||
    integer(fixture.provider_event_count, "provider event") !== 0 ||
    integer(fixture.completed_job_count, "completed job") < 1
  ) {
    throw new Error(
      "Hosted proof worker recovery did not converge to provider acceptance.",
    );
  }
}

function createRunId(): string {
  return `proof_${randomBytes(8).toString("hex")}`;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runPortableHostedProof(
  options: PortableHostedProofOptions,
): Promise<PortableHostedProofEvidence> {
  const apiOrigin = validateOptions(options);
  const runId = options.run_id ?? createRunId();
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetch ?? fetch;
  const wait = options.wait ?? waitFor;
  const scheduleDays = options.schedule_days ?? DEFAULT_SCHEDULE_DAYS;
  const timeoutSeconds =
    options.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  const startedAt = now();
  const scheduledAt = new Date(
    startedAt.getTime() + scheduleDays * 86_400_000,
  ).toISOString();
  const apiOriginSha256 = createHash("sha256")
    .update(apiOrigin.origin)
    .digest("hex");
  const idempotencyKey = `hayasend-${runId}`;
  const idempotencyKeyHash = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex");
  const ownedPool = new Pool({
    connectionString: options.database_url,
    max: 1,
    application_name: "hayasend-hosted-proof",
  });
  let emailId: string | undefined;
  let outboxId: string | undefined;
  let proofEvidence:
    | Omit<PortableHostedProofEvidence, "cleanup" | "completed_at">
    | undefined;
  let failure: unknown;
  let createAttempted = false;
  let cleanup:
    | PortableHostedProofEvidence["cleanup"]
    | undefined;

  try {
    const majorVersion = await databaseMajorVersion(ownedPool);
    assertEmptyBaseline(await baselineCounts(ownedPool));
    await healthCheck(fetcher, apiOrigin, "/healthz");
    await healthCheck(fetcher, apiOrigin, "/readyz");

    const body = JSON.stringify({
      from: "HayaSend Proof <proof-sender@example.com>",
      to: ["proof-recipient@example.net"],
      subject: `HayaSend portable proof ${runId}`,
      text: "Isolated console-only hosted lifecycle proof.",
      scheduled_at: scheduledAt,
    });
    const request = {
      method: "POST",
      headers: {
        ...authorization(options.api_key),
        "idempotency-key": idempotencyKey,
      },
      body,
    } satisfies RequestInit;
    createAttempted = true;
    const first = await responseJson<ApiEmail>(
      fetcher,
      new URL("/emails", apiOrigin),
      request,
    );
    if (
      typeof first.id !== "string" ||
      !EMAIL_ID_PATTERN.test(first.id)
    ) {
      throw new Error("Hosted proof API did not return an email identity.");
    }
    emailId = first.id;
    const replay = await responseJson<ApiEmail>(
      fetcher,
      new URL("/emails", apiOrigin),
      request,
    );
    if (replay.id !== first.id) {
      throw new Error("Hosted proof idempotency replay did not converge.");
    }

    const fixture = await deliveryFixture(ownedPool, emailId);
    outboxId = assertInitialFixture(fixture, emailId, scheduledAt);
    if ((await delayedJobCount(ownedPool, emailId, outboxId)) !== 1) {
      throw new Error(
        "Hosted proof durable delayed wake-up job is not singular.",
      );
    }

    const client = await ownedPool.connect();
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
    const final = await finalFixture(ownedPool, emailId, outboxId);
    assertFinalFixture(final);
    const scheduleHorizonSeconds = Math.floor(
      (Date.parse(scheduledAt) - startedAt.getTime()) / 1_000,
    );

    proofEvidence = {
      object: "portable_hosted_semantic_proof",
      schema_version: "1.0.0",
      hayasend_version: HAYASEND_VERSION,
      run_id: runId,
      started_at: startedAt.toISOString(),
      api_origin_sha256: apiOriginSha256,
      database: {
        engine: "postgresql",
        major_version: majorVersion,
        connection_verified: true,
      },
      transport: "portable-console",
      checks: {
        health: true,
        readiness: true,
        exact_runtime_version: true,
        isolated_empty_database: true,
        atomic_delivery_commit: true,
        idempotency_replay: true,
        scheduled_horizon_seconds: scheduleHorizonSeconds,
        schedule_exceeds_seven_days: true,
        durable_delayed_job_present: true,
        lost_wakeup_jobs_removed: lostWakeupJobs,
        authoritative_due_row_advanced: true,
        periodic_sweeper_recovered: true,
        email_state: "sent",
        message_state: "accepted",
        recipient_state: "accepted",
        provider_attempt_state: "accepted",
        provider_acceptance_only: true,
        terminal_delivery_claimed: false,
        external_send_performed: false,
        provider_events_observed: 0,
      },
      fixture: {
        email_id: emailId,
        outbox_id: outboxId,
      },
      privacy: {
        credentials_included: false,
        addresses_included: false,
        content_included: false,
        raw_errors_included: false,
      },
    };
  } catch (error) {
    failure = error;
  }

  if (!emailId && createAttempted) {
    try {
      emailId = await discoverFixtureEmailId(
        ownedPool,
        idempotencyKeyHash,
      );
    } catch (cleanupDiscoveryError) {
      failure = new Error(
        "Hosted proof failed and fixture discovery for cleanup also failed.",
        { cause: cleanupDiscoveryError },
      );
    }
  }

  if (emailId) {
    if (options.retain_fixture === true && failure === undefined) {
      cleanup = {
        retained_by_explicit_operator_request: true,
      };
    } else {
      try {
        const remaining = await cleanupFixture(
          ownedPool,
          emailId,
          outboxId,
        );
        if (remaining !== 0) {
          throw new Error("Hosted proof fixture cleanup is incomplete.");
        }
        cleanup = {
          retained_by_explicit_operator_request: false,
          fixture_rows_remaining: 0,
          complete: true,
        };
      } catch (cleanupError) {
        failure =
          failure === undefined
            ? cleanupError
            : new Error(
                "Hosted proof failed and fixture cleanup also failed.",
                { cause: cleanupError },
              );
      }
    }
  }

  try {
    await ownedPool.end();
  } catch (poolError) {
    failure ??= poolError;
  }
  if (failure) {
    throw failure;
  }
  if (!proofEvidence || !cleanup) {
    throw new Error("Hosted proof evidence was not completed.");
  }
  return {
    ...proofEvidence,
    completed_at: now().toISOString(),
    cleanup,
  };
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Set ${name} for the hosted proof.`);
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

export async function runPortableHostedProofProcess(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const retainFixture =
    environment.HAYASEND_HOSTED_PROOF_RETAIN === "true";
  const evidence = await runPortableHostedProof({
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
      "HAYASEND_CONSOLE_PROOF_CONFIRM",
    ),
    transport: requiredEnvironment(environment, "HAYASEND_TRANSPORT"),
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
    retain_fixture: retainFixture,
    ...(retainFixture
      ? {
          retain_confirmation: requiredEnvironment(
            environment,
            "HAYASEND_HOSTED_PROOF_RETAIN_CONFIRM",
          ),
        }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPortableHostedProofProcess().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        object: "portable_hosted_semantic_proof_failure",
        schema_version: "1.0.0",
        error_type: safeErrorCategory(error),
        credentials_included: false,
        content_included: false,
        raw_error_included: false,
      })}\n`,
    );
    process.exitCode = 1;
  });
}
