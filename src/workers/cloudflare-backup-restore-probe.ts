import { secretsEqual } from "../core/crypto.js";
import {
  createOutboxIdentity,
  createProviderEventIdentity,
  type OutboxItemRecord,
} from "../core/delivery-model.js";
import { D1DeliveryStore } from "../adapters/cloudflare/d1-delivery-store.js";
import {
  CloudflareJobQueue,
  type CloudflareJobEnvelope,
} from "../adapters/cloudflare/queues-job-queue.js";
import { R2PayloadStorage } from "../adapters/cloudflare/r2-payload-storage.js";
import { OutboxReconciler } from "../services/outbox-reconciler.js";

const MANAGED_METADATA = "hayasend-managed";
const SHA256_METADATA = "hayasend-sha256";
const MAX_PROOF_REQUEST_BYTES = 4_096;
const EMAIL_ID_PATTERN = /^email_[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const STATE_TABLES = [
  ["emails", "id"],
  ["delivery_messages", "id"],
  ["delivery_recipients", "id"],
  ["delivery_attempts", "id"],
  ["provider_events", "id"],
  ["provider_event_metrics", "singleton"],
  ["idempotency_claims", "key_hash"],
  ["outbox_items", "id"],
  ["outbox_metrics", "singleton"],
  ["delivery_ledger_versions", "message_id"],
  ["delivery_ledger_mutations", "operation_id"],
  ["outbox_mutations", "operation_id"],
  ["suppressions", "id"],
] as const;

const IMMUTABLE_LEDGER_TABLES = [
  ["delivery_messages", "id"],
  ["delivery_recipients", "id"],
  ["delivery_attempts", "id"],
  ["provider_events", "id"],
] as const;

interface ProofCounts {
  messages: number;
  recipients: number;
  attempts: number;
  provider_events: number;
  outbox: number;
  payload_objects: number;
}

export interface CloudflareBackupRestoreProbeEnv {
  DB: D1Database;
  PAYLOADS: R2Bucket;
  TARGET_PAYLOADS?: R2Bucket | undefined;
  RECOVERY_QUEUE?: Queue<CloudflareJobEnvelope> | undefined;
  HAYASEND_PROOF_TOKEN: string;
  HAYASEND_PROOF_MODE: "source" | "restore";
}

interface SourceRequest {
  action: "snapshot";
  sent_email_id: string;
  scheduled_email_id: string;
}

interface RestoreRequest {
  action: "verify";
  expected_state_sha256: string;
  scheduled_email_id: string;
}

interface PurgeRequest {
  action: "purge_restore_payloads";
}

type ProofRequest = SourceRequest | RestoreRequest | PurgeRequest;

interface PayloadDigest {
  objects: number;
  bytes: number;
  sha256: string;
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=UTF-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function authenticate(
  request: Request,
  env: CloudflareBackupRestoreProbeEnv,
): void {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (
    !token ||
    !env.HAYASEND_PROOF_TOKEN ||
    !secretsEqual(token, env.HAYASEND_PROOF_TOKEN)
  ) {
    throw new Error("unauthorized");
  }
}

async function requestBody(request: Request): Promise<ProofRequest> {
  const text = await request.text();
  if (
    new TextEncoder().encode(text).byteLength >
    MAX_PROOF_REQUEST_BYTES
  ) {
    throw new Error("invalid proof request");
  }
  const value = JSON.parse(text) as Partial<ProofRequest>;
  if (
    value.action === "snapshot" &&
    typeof value.sent_email_id === "string" &&
    EMAIL_ID_PATTERN.test(value.sent_email_id) &&
    typeof value.scheduled_email_id === "string" &&
    EMAIL_ID_PATTERN.test(value.scheduled_email_id)
  ) {
    return value as SourceRequest;
  }
  if (
    value.action === "verify" &&
    typeof value.expected_state_sha256 === "string" &&
    SHA256_PATTERN.test(value.expected_state_sha256) &&
    typeof value.scheduled_email_id === "string" &&
    EMAIL_ID_PATTERN.test(value.scheduled_email_id)
  ) {
    return value as RestoreRequest;
  }
  if (value.action === "purge_restore_payloads") {
    return value as PurgeRequest;
  }
  throw new Error("invalid proof request");
}

async function tableDigest(
  database: D1Database,
  tables: ReadonlyArray<readonly [string, string]>,
): Promise<string> {
  const state: Array<{ table: string; rows: unknown[] }> = [];
  for (const [table, order] of tables) {
    const rows = await database
      .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
      .all<Record<string, unknown>>();
    state.push({ table, rows: rows.results });
  }
  return sha256(canonicalJson(state));
}

async function payloadDigest(
  source: R2Bucket,
  target?: R2Bucket,
): Promise<PayloadDigest> {
  const entries: Array<{
    key: string;
    size: number;
    sha256: string;
    http_metadata: R2HTTPMetadata;
    custom_metadata: Record<string, string>;
  }> = [];
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await source.list({
      ...(cursor ? { cursor } : {}),
      include: ["httpMetadata", "customMetadata"],
    });
    for (const object of page.objects) {
      if (object.customMetadata?.[MANAGED_METADATA] !== "true") {
        throw new Error("unmanaged payload object");
      }
      const body = await source.get(object.key);
      if (!body) {
        throw new Error("payload object disappeared");
      }
      const content = await body.arrayBuffer();
      const checksum = await sha256(content);
      if (
        checksum !== body.customMetadata?.[SHA256_METADATA] ||
        checksum !==
          (body.checksums.sha256
            ? hex(body.checksums.sha256)
            : undefined)
      ) {
        throw new Error("payload integrity failure");
      }
      if (target) {
        await target.put(object.key, content, {
          ...(body.httpMetadata
            ? { httpMetadata: body.httpMetadata }
            : {}),
          customMetadata: body.customMetadata,
          sha256: checksum,
        });
        const restored = await target.head(object.key);
        if (
          !restored ||
          restored.size !== body.size ||
          restored.customMetadata?.[SHA256_METADATA] !== checksum ||
          checksum !==
            (restored.checksums.sha256
              ? hex(restored.checksums.sha256)
              : undefined)
        ) {
          throw new Error("restored payload integrity failure");
        }
      }
      entries.push({
        key: object.key,
        size: body.size,
        sha256: checksum,
        http_metadata: body.httpMetadata ?? {},
        custom_metadata: body.customMetadata ?? {},
      });
      bytes += body.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  entries.sort((left, right) => left.key.localeCompare(right.key));
  return {
    objects: entries.length,
    bytes,
    sha256: await sha256(canonicalJson(entries)),
  };
}

async function applicationCounts(
  database: D1Database,
  payloadObjects: number,
): Promise<ProofCounts> {
  const row = await database
    .prepare(
      "SELECT (SELECT COUNT(*) FROM delivery_messages) AS messages, (SELECT COUNT(*) FROM delivery_recipients) AS recipients, (SELECT COUNT(*) FROM delivery_attempts) AS attempts, (SELECT COUNT(*) FROM provider_events) AS provider_events, (SELECT COUNT(*) FROM outbox_items) AS outbox",
    )
    .first<Omit<ProofCounts, "payload_objects">>();
  if (!row) {
    throw new Error("missing state counts");
  }
  const counts = { ...row, payload_objects: payloadObjects };
  if (
    counts.messages < 2 ||
    counts.recipients < 2 ||
    counts.attempts < 1 ||
    counts.provider_events < 1 ||
    counts.outbox < 2 ||
    counts.payload_objects < 2
  ) {
    throw new Error("incomplete backup fixture");
  }
  return counts;
}

async function stateSnapshot(
  database: D1Database,
  payloads: R2Bucket,
  copyTarget?: R2Bucket,
): Promise<{
  state_sha256: string;
  payload: PayloadDigest;
  counts: ProofCounts;
}> {
  const [d1, payload] = await Promise.all([
    tableDigest(database, STATE_TABLES),
    payloadDigest(payloads, copyTarget),
  ]);
  return {
    state_sha256: await sha256(
      canonicalJson({ d1_sha256: d1, r2_sha256: payload.sha256 }),
    ),
    payload,
    counts: await applicationCounts(database, payload.objects),
  };
}

async function seedTerminalFixture(
  store: D1DeliveryStore,
  sentEmailId: string,
): Promise<void> {
  const ledger = await store.getDeliveryLedger(sentEmailId);
  if (!ledger) {
    throw new Error("sent fixture is missing");
  }
  const attempt = [...ledger.attempts]
    .reverse()
    .find(
      (candidate) =>
        candidate.status === "accepted" &&
        candidate.provider_message_id !== undefined,
    );
  if (!attempt?.provider_message_id) {
    throw new Error("accepted fixture attempt is missing");
  }
  const source = {
    kind: "provider_event_id" as const,
    value: `backup-restore-drill-${sentEmailId}`,
  };
  const now = new Date().toISOString();
  const result = await store.appendProviderEvent({
    schema_version: "1.0.0",
    record_type: "provider_event",
    id: createProviderEventIdentity({
      provider: ledger.message.provider.name,
      source,
    }),
    provider: ledger.message.provider,
    source,
    message_id: ledger.message.id,
    attempt_id: attempt.id,
    recipient_ids: [...ledger.message.recipient_ids],
    provider_message_id: attempt.provider_message_id,
    type: "delivered",
    provider_at: attempt.completed_at ?? now,
    received_at: now,
    terminal: true,
  });
  if (!result) {
    throw new Error("terminal fixture was not persisted");
  }
}

async function verifyHydration(
  database: D1Database,
  store: D1DeliveryStore,
): Promise<void> {
  const foreignKeys = await database
    .prepare("PRAGMA foreign_key_check")
    .all<Record<string, unknown>>();
  if (foreignKeys.results.length > 0) {
    throw new Error("foreign key consistency failure");
  }
  const rows = await database
    .prepare("SELECT id FROM delivery_messages ORDER BY id")
    .all<{ id: string }>();
  for (const row of rows.results) {
    const ledger = await store.getDeliveryLedger(row.id);
    if (!ledger) {
      throw new Error("delivery ledger hydration failure");
    }
  }
}

async function scheduledOutbox(
  store: D1DeliveryStore,
  emailId: string,
): Promise<OutboxItemRecord> {
  const ledger = await store.getDeliveryLedger(emailId);
  const outbox = await store.getOutboxItem(
    createOutboxIdentity({
      message_id: emailId,
      job_type: "dispatch-message",
      generation: 0,
    }),
  );
  if (!ledger || ledger.email.status !== "scheduled" || !outbox) {
    throw new Error("scheduled recovery fixture is missing");
  }
  return outbox;
}

async function makeScheduledWorkDue(
  database: D1Database,
  store: D1DeliveryStore,
  scheduledEmailId: string,
  now: Date,
): Promise<string> {
  const outbox = await scheduledOutbox(store, scheduledEmailId);
  if (outbox.dispatched_at !== undefined) {
    throw new Error("scheduled recovery fixture was already dispatched");
  }
  const nowIso = now.toISOString();
  const updated = {
    ...outbox,
    due_at: nowIso,
    updated_at: nowIso,
  };
  delete updated.lease_owner;
  delete updated.lease_expires_at;
  const result = await database
    .prepare(
      "UPDATE outbox_items SET due_at = ?, lease_owner = NULL, lease_expires_at = NULL, entity = ?, updated_at = ? WHERE id = ? AND dispatched_at IS NULL",
    )
    .bind(nowIso, JSON.stringify(updated), nowIso, outbox.id)
    .run();
  if (result.meta.changes !== 1) {
    throw new Error("scheduled recovery fixture could not be made due");
  }
  return outbox.id;
}

async function sourceProof(
  input: SourceRequest,
  env: CloudflareBackupRestoreProbeEnv,
): Promise<Response> {
  if (env.HAYASEND_PROOF_MODE !== "source" || !env.TARGET_PAYLOADS) {
    throw new Error("invalid source proof binding");
  }
  const store = new D1DeliveryStore(
    env.DB,
    new R2PayloadStorage(env.PAYLOADS),
  );
  await seedTerminalFixture(store, input.sent_email_id);
  await scheduledOutbox(store, input.scheduled_email_id);
  const snapshot = await stateSnapshot(
    env.DB,
    env.PAYLOADS,
    env.TARGET_PAYLOADS,
  );
  const copied = await payloadDigest(env.TARGET_PAYLOADS);
  if (
    copied.objects !== snapshot.payload.objects ||
    copied.bytes !== snapshot.payload.bytes ||
    copied.sha256 !== snapshot.payload.sha256
  ) {
    throw new Error("payload copy did not converge");
  }
  return json({
    object: "cloudflare_backup_snapshot_proof",
    schema_version: "1.0.0",
    state_sha256: snapshot.state_sha256,
    counts: snapshot.counts,
    payload_bytes: snapshot.payload.bytes,
    fixture_event: "synthetic_terminal_for_restore_only",
    production_delivery_evidence: false,
  });
}

async function restoreProof(
  input: RestoreRequest,
  env: CloudflareBackupRestoreProbeEnv,
): Promise<Response> {
  if (env.HAYASEND_PROOF_MODE !== "restore" || !env.RECOVERY_QUEUE) {
    throw new Error("invalid restore proof binding");
  }
  const payloads = new R2PayloadStorage(env.PAYLOADS);
  const store = new D1DeliveryStore(env.DB, payloads);
  const restored = await stateSnapshot(env.DB, env.PAYLOADS);
  if (restored.state_sha256 !== input.expected_state_sha256) {
    throw new Error("restored state digest mismatch");
  }
  await verifyHydration(env.DB, store);
  const immutableBefore = await tableDigest(
    env.DB,
    IMMUTABLE_LEDGER_TABLES,
  );
  const now = new Date();
  const outboxId = await makeScheduledWorkDue(
    env.DB,
    store,
    input.scheduled_email_id,
    now,
  );
  const reconciler = new OutboxReconciler(
    store,
    new CloudflareJobQueue(env.RECOVERY_QUEUE),
    { owner: "backup-restore-proof" },
  );
  const first = await reconciler.sweep(now);
  const second = await reconciler.sweep(now);
  const immutableAfter = await tableDigest(
    env.DB,
    IMMUTABLE_LEDGER_TABLES,
  );
  const recovered = await store.getOutboxItem(outboxId);
  if (
    first.leased !== 1 ||
    first.dispatched !== 1 ||
    first.failed !== 0 ||
    second.leased !== 0 ||
    second.dispatched !== 0 ||
    second.failed !== 0 ||
    recovered?.dispatched_at === undefined ||
    immutableBefore !== immutableAfter
  ) {
    throw new Error("restored due-work recovery did not converge");
  }
  return json({
    object: "cloudflare_backup_restore_proof",
    schema_version: "1.0.0",
    status: "passed",
    restored_state_sha256: restored.state_sha256,
    counts: restored.counts,
    payload_bytes: restored.payload.bytes,
    relational_integrity: "passed",
    payload_integrity: "passed",
    hydration: "passed",
    due_work_recovery: {
      first_sweep: first,
      second_sweep: second,
      deterministic_single_dispatch: true,
    },
    immutable_delivery_ledger_unchanged: true,
    external_send_performed_during_restore: false,
  });
}

async function purgeRestorePayloads(
  env: CloudflareBackupRestoreProbeEnv,
): Promise<Response> {
  const bucket =
    env.HAYASEND_PROOF_MODE === "source"
      ? env.TARGET_PAYLOADS
      : env.PAYLOADS;
  if (!bucket) {
    throw new Error("restore payload binding is missing");
  }
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      ...(cursor ? { cursor } : {}),
    });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({
    object: "cloudflare_backup_restore_cleanup",
    deleted_payload_objects: deleted,
    complete: true,
  });
}

async function route(
  request: Request,
  env: CloudflareBackupRestoreProbeEnv,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/") {
    return json({ name: "not_found" }, 404);
  }
  authenticate(request, env);
  const input = await requestBody(request);
  if (input.action === "snapshot") {
    return sourceProof(input, env);
  }
  if (input.action === "verify") {
    return restoreProof(input, env);
  }
  return purgeRestorePayloads(env);
}

export default {
  async fetch(
    request: Request,
    env: CloudflareBackupRestoreProbeEnv,
  ): Promise<Response> {
    try {
      return await route(request, env);
    } catch {
      return json(
        {
          object: "cloudflare_backup_restore_proof",
          status: "failed",
          name: "proof_failed",
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<CloudflareBackupRestoreProbeEnv>;
