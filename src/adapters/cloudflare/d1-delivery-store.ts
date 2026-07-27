import { validateDeliveryCommit } from "../../core/delivery-commit.js";
import {
  deliveryAttemptRecordSchema,
  deliveryDiagnosticCategorySchema,
  deliveryMessageRecordSchema,
  isEquivalentProviderEventReplay,
  outboxItemRecordSchema,
  providerEventRecordSchema,
  recipientRecordSchema,
  type DeliveryAttemptRecord,
  type DeliveryDiagnosticCategory,
  type DeliveryMessageRecord,
  type OutboxItemRecord,
  type ProviderEventRecord,
  type RecipientRecord,
} from "../../core/delivery-model.js";
import { ConflictError } from "../../core/errors.js";
import {
  planAttemptCompletion,
  planAttemptStart,
  planLocalRecipientState,
  planProviderEvent,
  type AttemptCompletion,
  type DeliveryLedgerPlan,
} from "../../core/recipient-ledger.js";
import type { EmailRecord, IdempotencyClaim } from "../../core/types.js";
import type {
  DeliveryCommit,
  DeliveryCommitResult,
  DeliveryOutboxStore,
  LeaseDueOutboxInput,
  OutboxMetrics,
} from "../../ports/delivery-outbox-store.js";
import type {
  DeliveryLedgerMutationResult,
  DeliveryLedgerSnapshot,
  DeliveryLedgerStore,
} from "../../ports/delivery-ledger-store.js";
import {
  injectCloudflareFault,
  type CloudflareFaultInjector,
} from "./fault-injection.js";
import type { R2PayloadStorage } from "./r2-payload-storage.js";

const DELIVERY_LEDGER_RETRIES = 8;
const MAX_RECIPIENTS = 50;

interface D1DeliveryStoreOptions {
  fault_injector?: CloudflareFaultInjector | undefined;
}

interface EntityRow {
  entity: string;
}

interface LedgerHeaderRow {
  email_entity: string;
  message_entity: string;
  revision: number;
}

interface IdempotencyRow {
  key_hash: string;
  request_hash: string;
  email_id: string;
  expires_at: number;
}

interface StoredDeliveryState {
  revision: number;
  snapshot: Omit<DeliveryLedgerSnapshot, "events">;
}

interface AggregateMetricsRow {
  due: number;
  leased: number;
  stuck_leases: number;
  undispatched: number;
  oldest_due_at: string | null;
}

function parseEntity<T>(row: EntityRow | null): T | undefined {
  return row ? (JSON.parse(row.entity) as T) : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function constraintFailure(error: unknown): boolean {
  const message = String((error as { message?: unknown }).message ?? error);
  return /constraint|unique|stale delivery ledger revision|outbox lease is not owned/iu.test(
    message,
  );
}

function staleLedger(error: unknown): boolean {
  return String(
    (error as { message?: unknown }).message ?? error,
  ).includes("stale delivery ledger revision");
}

function validateLeaseInput(input: LeaseDueOutboxInput): void {
  if (!/^[^\s@]{1,512}$/.test(input.owner)) {
    throw new Error("Outbox lease owner must be a privacy-safe opaque ID.");
  }
  if (!Number.isInteger(input.lease_seconds) || input.lease_seconds <= 0) {
    throw new Error("Outbox lease duration must be a positive integer.");
  }
  if (
    !Number.isInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > 1_000
  ) {
    throw new Error("Outbox lease limit must be between 1 and 1000.");
  }
}

export class D1DeliveryStore
  implements DeliveryOutboxStore, DeliveryLedgerStore
{
  constructor(
    private readonly database: D1Database,
    private readonly payloadStorage?: R2PayloadStorage,
    private readonly options: D1DeliveryStoreOptions = {},
  ) {}

  async commitDelivery(
    input: DeliveryCommit,
    nowEpochSeconds: number,
  ): Promise<DeliveryCommitResult> {
    const validated = validateDeliveryCommit(input, nowEpochSeconds);
    if (validated.recipients.length > MAX_RECIPIENTS) {
      throw new Error(
        `Cloudflare delivery commits cannot exceed ${MAX_RECIPIENTS} recipients.`,
      );
    }
    if (validated.idempotency) {
      const replay = await this.replayForIdempotency(
        validated.idempotency,
        nowEpochSeconds,
      );
      if (replay) {
        return replay;
      }
    }

    const persistedEmail = this.payloadStorage
      ? await this.payloadStorage.externalizeEmail(validated.email)
      : validated.email;
    const statements: D1PreparedStatement[] = [];
    await this.stageWrite(
      statements,
      "commit",
      "email",
      this.database
        .prepare(
          "INSERT INTO emails(id, entity, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(
          persistedEmail.id,
          json(persistedEmail),
          persistedEmail.created_at,
          persistedEmail.updated_at,
        ),
    );
    await this.stageWrite(
      statements,
      "commit",
      "message",
      this.database
        .prepare(
          "INSERT INTO delivery_messages(id, entity, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(
          validated.message.id,
          json(validated.message),
          validated.message.created_at,
          validated.message.updated_at,
        ),
    );
    for (const [index, recipient] of validated.recipients.entries()) {
      await this.stageWrite(
        statements,
        "commit",
        "recipient",
        this.database
          .prepare(
            "INSERT INTO delivery_recipients(id, message_id, role, ordinal, entity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            recipient.id,
            recipient.message_id,
            recipient.role,
            recipient.ordinal,
            json(recipient),
            recipient.created_at,
            recipient.updated_at,
          ),
        index,
      );
    }
    await this.stageWrite(
      statements,
      "commit",
      "outbox",
      this.database
        .prepare(
          "INSERT INTO outbox_items(id, message_id, due_at, lease_owner, lease_expires_at, dispatched_at, attempts, last_diagnostic_category, entity, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)",
        )
        .bind(
          validated.outbox.id,
          validated.outbox.message_id,
          validated.outbox.due_at,
          validated.outbox.dispatched_at ?? null,
          validated.outbox.attempts,
          json(validated.outbox),
          validated.outbox.created_at,
          validated.outbox.updated_at,
        ),
    );
    await this.stageWrite(
      statements,
      "commit",
      "ledger-version",
      this.database
        .prepare(
          "INSERT INTO delivery_ledger_versions(message_id, revision) VALUES (?, 0)",
        )
        .bind(validated.message.id),
    );
    if (validated.idempotency) {
      await this.stageWrite(
        statements,
        "commit",
        "idempotency",
        this.database
          .prepare(
            "INSERT INTO idempotency_claims(key_hash, request_hash, email_id, expires_at) VALUES (?, ?, ?, ?)",
          )
          .bind(
            validated.idempotency.key_hash,
            validated.idempotency.request_hash,
            validated.email.id,
            validated.idempotency.expires_at,
          ),
      );
    }

    try {
      await this.executeBatch(
        "commit",
        validated.message.id,
        statements,
      );
      return { ...validated, replayed: false };
    } catch (error) {
      if (validated.idempotency && constraintFailure(error)) {
        const replay = await this.replayForIdempotency(
          validated.idempotency,
          nowEpochSeconds,
        );
        if (replay) {
          return replay;
        }
      }
      if (constraintFailure(error)) {
        throw new ConflictError("Delivery identity is already in use.");
      }
      throw error;
    }
  }

  async getDelivery(
    messageId: string,
  ): Promise<DeliveryCommitResult | undefined> {
    const [emailRow, messageRow, recipientRows, outboxRow, claimRow] =
      await Promise.all([
        this.first<EntityRow>(
          "read",
          "email",
          this.database
            .prepare("SELECT entity FROM emails WHERE id = ?")
            .bind(messageId),
        ),
        this.first<EntityRow>(
          "read",
          "message",
          this.database
            .prepare("SELECT entity FROM delivery_messages WHERE id = ?")
            .bind(messageId),
        ),
        this.all<EntityRow>(
          "read",
          "recipients",
          this.database
            .prepare(
              "SELECT entity FROM delivery_recipients WHERE message_id = ? ORDER BY role, ordinal, id",
            )
            .bind(messageId),
        ),
        this.first<EntityRow>(
          "read",
          "outbox",
          this.database
            .prepare(
              "SELECT entity FROM outbox_items WHERE message_id = ?",
            )
            .bind(messageId),
        ),
        this.first<IdempotencyRow>(
          "read",
          "idempotency",
          this.database
            .prepare(
              "SELECT key_hash, request_hash, email_id, expires_at FROM idempotency_claims WHERE email_id = ? ORDER BY expires_at DESC LIMIT 1",
            )
            .bind(messageId),
        ),
      ]);
    const persistedEmail = parseEntity<EmailRecord>(emailRow);
    const messageValue = parseEntity<DeliveryMessageRecord>(messageRow);
    const outboxValue = parseEntity<OutboxItemRecord>(outboxRow);
    if (!persistedEmail || !messageValue || !outboxValue) {
      return undefined;
    }
    const message = deliveryMessageRecordSchema.parse(messageValue);
    const recipientById = new Map(
      recipientRows.results
        .map((row) => recipientRecordSchema.parse(JSON.parse(row.entity)))
        .map((recipient) => [recipient.id, recipient]),
    );
    const recipients = message.recipient_ids
      .map((id) => recipientById.get(id))
      .filter(
        (recipient): recipient is RecipientRecord =>
          recipient !== undefined,
      );
    if (recipients.length !== message.recipient_ids.length) {
      return undefined;
    }
    const email = this.payloadStorage
      ? await this.payloadStorage.hydrateEmail(persistedEmail)
      : persistedEmail;
    const idempotency: IdempotencyClaim | undefined = claimRow
      ? {
          key_hash: claimRow.key_hash,
          request_hash: claimRow.request_hash,
          expires_at: claimRow.expires_at,
        }
      : undefined;
    return {
      email,
      message,
      recipients,
      outbox: outboxItemRecordSchema.parse(outboxValue),
      ...(idempotency ? { idempotency } : {}),
      replayed: false,
    };
  }

  async getDeliveryLedger(
    messageId: string,
  ): Promise<DeliveryLedgerSnapshot | undefined> {
    const [stored, eventRows] = await Promise.all([
      this.getStoredDeliveryState(messageId),
      this.all<EntityRow>(
        "read",
        "provider-events",
        this.database
          .prepare(
            "SELECT entity FROM provider_events WHERE message_id = ? ORDER BY received_at, id",
          )
          .bind(messageId),
      ),
    ]);
    if (!stored) {
      return undefined;
    }
    const email = this.payloadStorage
      ? await this.payloadStorage.hydrateEmail(stored.snapshot.email)
      : stored.snapshot.email;
    return {
      ...stored.snapshot,
      email,
      events: eventRows.results.map((row) =>
        providerEventRecordSchema.parse(JSON.parse(row.entity)),
      ),
    };
  }

  async findMessageIdByProviderMessageId(
    providerMessageId: string,
  ): Promise<string | undefined> {
    if (
      providerMessageId.length < 1 ||
      providerMessageId.length > 512 ||
      !/^[\x21-\x3F\x41-\x7E]+$/.test(providerMessageId)
    ) {
      throw new Error("Provider message ID is not privacy-safe opaque data.");
    }
    const row = await this.first<{ message_id: string }>(
      "read",
      "provider-message-correlation",
      this.database
        .prepare(
          "SELECT message_id FROM delivery_attempts WHERE provider = ? AND provider_message_id = ? LIMIT 1",
        )
        .bind("cloudflare-email", providerMessageId),
    );
    return row?.message_id;
  }

  async beginDeliveryAttempt(
    input: DeliveryAttemptRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const attempt = deliveryAttemptRecordSchema.parse(input);
    for (let retry = 0; retry < DELIVERY_LEDGER_RETRIES; retry += 1) {
      const stored = await this.getStoredDeliveryState(attempt.message_id);
      if (!stored) {
        return undefined;
      }
      const existing = stored.snapshot.attempts.find(
        (candidate) =>
          candidate.id === attempt.id ||
          candidate.sequence === attempt.sequence,
      );
      if (existing) {
        if (json(existing) !== json(attempt)) {
          throw new ConflictError(
            "Delivery attempt identity or sequence is already in use.",
          );
        }
        return this.deliveryLedgerResult(
          attempt.message_id,
          true,
          [],
          { attempt: existing },
        );
      }
      const plan = planAttemptStart(stored.snapshot, attempt);
      try {
        await this.commitLedgerPlan(stored, plan, {
          operation: `attempt-start:${attempt.id}`,
          put_attempt: attempt,
        });
        return this.deliveryLedgerResult(
          attempt.message_id,
          false,
          plan.changed_recipient_ids,
          { attempt },
        );
      } catch (error) {
        if (!staleLedger(error) && !constraintFailure(error)) {
          throw error;
        }
      }
    }
    throw new ConflictError(
      "Delivery attempt could not be started after concurrent updates.",
    );
  }

  async completeDeliveryAttempt(
    input: AttemptCompletion,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    for (let retry = 0; retry < DELIVERY_LEDGER_RETRIES; retry += 1) {
      const stored = await this.getStoredDeliveryState(input.message_id);
      if (!stored) {
        return undefined;
      }
      const existing = stored.snapshot.attempts.find(
        (attempt) => attempt.id === input.attempt_id,
      );
      if (!existing) {
        throw new ConflictError("Delivery attempt does not exist.");
      }
      if (existing.status !== "submitting") {
        const sameCompletion =
          existing.status === input.status &&
          existing.completed_at ===
            new Date(input.completed_at).toISOString() &&
          existing.provider_message_id === input.provider_message_id &&
          existing.diagnostic_category === input.diagnostic_category;
        if (!sameCompletion) {
          throw new ConflictError(
            "Delivery attempt has already completed differently.",
          );
        }
        return this.deliveryLedgerResult(
          input.message_id,
          true,
          [],
          { attempt: existing },
        );
      }
      const plan = planAttemptCompletion(stored.snapshot, input);
      try {
        await this.commitLedgerPlan(stored, plan, {
          operation: `attempt-complete:${input.attempt_id}`,
          update_attempt: plan.attempt,
        });
        return this.deliveryLedgerResult(
          input.message_id,
          false,
          plan.changed_recipient_ids,
          { attempt: plan.attempt },
        );
      } catch (error) {
        if (!staleLedger(error)) {
          throw error;
        }
      }
    }
    throw new ConflictError(
      "Delivery attempt could not be completed after concurrent updates.",
    );
  }

  async appendProviderEvent(
    input: ProviderEventRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const event = providerEventRecordSchema.parse(input);
    const replay = await this.getProviderEvent(event.id);
    if (replay) {
      return this.providerEventReplay(replay, event);
    }
    for (let retry = 0; retry < DELIVERY_LEDGER_RETRIES; retry += 1) {
      const stored = await this.getStoredDeliveryState(event.message_id);
      if (!stored) {
        return undefined;
      }
      const plan = planProviderEvent(stored.snapshot, event);
      try {
        await this.commitLedgerPlan(stored, plan, {
          operation: `provider-event:${event.id}`,
          put_event: event,
        });
        return this.deliveryLedgerResult(
          event.message_id,
          false,
          plan.changed_recipient_ids,
          { event },
        );
      } catch (error) {
        if (!staleLedger(error) && !constraintFailure(error)) {
          throw error;
        }
        const existing = await this.getProviderEvent(event.id);
        if (existing) {
          return this.providerEventReplay(existing, event);
        }
      }
    }
    throw new ConflictError(
      "Provider event could not be appended after concurrent updates.",
    );
  }

  async applyLocalDeliveryState(
    messageId: string,
    status: "canceled" | "suppressed",
    updatedAt: string,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    for (let retry = 0; retry < DELIVERY_LEDGER_RETRIES; retry += 1) {
      const stored = await this.getStoredDeliveryState(messageId);
      if (!stored) {
        return undefined;
      }
      const plan = planLocalRecipientState(
        stored.snapshot,
        status,
        updatedAt,
      );
      try {
        await this.commitLedgerPlan(stored, plan, {
          operation: `local-state:${status}:${updatedAt}`,
        });
        return this.deliveryLedgerResult(
          messageId,
          false,
          plan.changed_recipient_ids,
        );
      } catch (error) {
        if (!staleLedger(error)) {
          throw error;
        }
      }
    }
    throw new ConflictError(
      "Local delivery state could not be applied after concurrent updates.",
    );
  }

  async getProviderEvent(
    id: string,
  ): Promise<ProviderEventRecord | undefined> {
    const row = await this.first<EntityRow>(
      "read",
      "provider-event",
      this.database
        .prepare("SELECT entity FROM provider_events WHERE id = ?")
        .bind(id),
    );
    const value = parseEntity<ProviderEventRecord>(row);
    return value ? providerEventRecordSchema.parse(value) : undefined;
  }

  async getLatestProviderEventReceivedAt(): Promise<string | undefined> {
    const row = await this.first<{ latest_received_at: string | null }>(
      "read",
      "provider-event-metrics",
      this.database.prepare(
        "SELECT latest_received_at FROM provider_event_metrics WHERE singleton = 1",
      ),
    );
    return row?.latest_received_at ?? undefined;
  }

  async getOutboxItem(id: string): Promise<OutboxItemRecord | undefined> {
    const row = await this.first<EntityRow>(
      "read",
      "outbox",
      this.database
        .prepare("SELECT entity FROM outbox_items WHERE id = ?")
        .bind(id),
    );
    const value = parseEntity<OutboxItemRecord>(row);
    return value ? outboxItemRecordSchema.parse(value) : undefined;
  }

  async leaseDueOutbox(
    input: LeaseDueOutboxInput,
  ): Promise<OutboxItemRecord[]> {
    validateLeaseInput(input);
    const nowIso = input.now.toISOString();
    const leaseExpiresAt = new Date(
      input.now.getTime() + input.lease_seconds * 1_000,
    ).toISOString();
    const candidates = await this.all<EntityRow>(
      "read",
      "outbox-due",
      this.database
        .prepare(
          "SELECT entity FROM outbox_items WHERE dispatched_at IS NULL AND due_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?) ORDER BY due_at, id LIMIT ?",
        )
        .bind(nowIso, nowIso, input.limit),
    );
    const statements: D1PreparedStatement[] = [];
    for (const [index, row] of candidates.results.entries()) {
      const current = outboxItemRecordSchema.parse(JSON.parse(row.entity));
      const updated = outboxItemRecordSchema.parse({
        ...current,
        attempts: current.attempts + 1,
        lease_owner: input.owner,
        lease_expires_at: leaseExpiresAt,
        updated_at: nowIso,
      });
      await this.stageWrite(
        statements,
        "lease",
        current.id,
        this.database
          .prepare(
            "UPDATE outbox_items SET lease_owner = ?, lease_expires_at = ?, attempts = ?, entity = ?, updated_at = ? WHERE id = ? AND dispatched_at IS NULL AND due_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?) RETURNING entity",
          )
          .bind(
            input.owner,
            leaseExpiresAt,
            updated.attempts,
            json(updated),
            nowIso,
            current.id,
            nowIso,
            nowIso,
          ),
        index,
      );
    }
    if (statements.length === 0) {
      return [];
    }
    const results = await this.executeBatch(
      "lease",
      input.owner,
      statements,
    );
    return results.flatMap((result) =>
      (result.results as EntityRow[]).map((row) =>
        outboxItemRecordSchema.parse(JSON.parse(row.entity)),
      ),
    );
  }

  async acknowledgeOutbox(
    id: string,
    owner: string,
    now: Date,
  ): Promise<boolean> {
    const current = await this.getOutboxItem(id);
    if (
      !current ||
      current.dispatched_at !== undefined ||
      current.lease_owner !== owner
    ) {
      return false;
    }
    const nowIso = now.toISOString();
    const updated = outboxItemRecordSchema.parse({
      ...current,
      lease_owner: undefined,
      lease_expires_at: undefined,
      dispatched_at: nowIso,
      updated_at: nowIso,
    });
    return this.commitOwnedOutboxMutation(
      "acknowledge",
      updated,
      owner,
      nowIso,
    );
  }

  async recordOutboxFailure(
    id: string,
    owner: string,
    category: DeliveryDiagnosticCategory,
    now: Date,
  ): Promise<boolean> {
    const current = await this.getOutboxItem(id);
    if (
      !current ||
      current.dispatched_at !== undefined ||
      current.lease_owner !== owner
    ) {
      return false;
    }
    const diagnostic = deliveryDiagnosticCategorySchema.parse(category);
    const nowIso = now.toISOString();
    const updated = outboxItemRecordSchema.parse({
      ...current,
      lease_owner: undefined,
      lease_expires_at: undefined,
      last_diagnostic_category: diagnostic,
      updated_at: nowIso,
    });
    return this.commitOwnedOutboxMutation(
      "failure",
      updated,
      owner,
      nowIso,
    );
  }

  async getOutboxMetrics(now: Date): Promise<OutboxMetrics> {
    const nowIso = now.toISOString();
    const [aggregate, durable] = await Promise.all([
      this.first<AggregateMetricsRow>(
        "read",
        "outbox-metrics",
        this.database
          .prepare(
            "SELECT CAST(COALESCE(SUM(CASE WHEN dispatched_at IS NULL AND due_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?) THEN 1 ELSE 0 END), 0) AS INTEGER) AS due, CAST(COALESCE(SUM(CASE WHEN dispatched_at IS NULL AND due_at <= ? AND lease_expires_at > ? THEN 1 ELSE 0 END), 0) AS INTEGER) AS leased, CAST(COALESCE(SUM(CASE WHEN dispatched_at IS NULL AND due_at <= ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN 1 ELSE 0 END), 0) AS INTEGER) AS stuck_leases, CAST(COALESCE(SUM(CASE WHEN dispatched_at IS NULL THEN 1 ELSE 0 END), 0) AS INTEGER) AS undispatched, MIN(CASE WHEN dispatched_at IS NULL AND due_at <= ? THEN due_at END) AS oldest_due_at FROM outbox_items",
          )
          .bind(
            nowIso,
            nowIso,
            nowIso,
            nowIso,
            nowIso,
            nowIso,
            nowIso,
          ),
      ),
      this.first<{ publish_failures_total: number }>(
        "read",
        "outbox-failure-metrics",
        this.database.prepare(
          "SELECT publish_failures_total FROM outbox_metrics WHERE singleton = 1",
        ),
      ),
    ]);
    const oldestDueAt = aggregate?.oldest_due_at
      ? Date.parse(aggregate.oldest_due_at)
      : undefined;
    return {
      due: Number(aggregate?.due ?? 0),
      leased: Number(aggregate?.leased ?? 0),
      stuck_leases: Number(aggregate?.stuck_leases ?? 0),
      undispatched: Number(aggregate?.undispatched ?? 0),
      oldest_due_age_seconds:
        oldestDueAt === undefined
          ? 0
          : Math.max(
              0,
              Math.floor((now.getTime() - oldestDueAt) / 1_000),
            ),
      publish_failures_total: Number(
        durable?.publish_failures_total ?? 0,
      ),
      truncated: false,
    };
  }

  async listReferencedPayloadKeys(): Promise<Set<string>> {
    const rows = await this.all<EntityRow>(
      "read",
      "payload-references",
      this.database.prepare(
        "SELECT entity FROM emails WHERE json_extract(entity, '$.payload_ref') IS NOT NULL",
      ),
    );
    return new Set(
      rows.results
        .map((row) => JSON.parse(row.entity) as EmailRecord)
        .map((record) => record.payload_ref)
        .filter((key): key is string => typeof key === "string"),
    );
  }

  private async replayForIdempotency(
    idempotency: IdempotencyClaim,
    nowEpochSeconds: number,
  ): Promise<DeliveryCommitResult | undefined> {
    const claim = await this.first<IdempotencyRow>(
      "read",
      "idempotency",
      this.database
        .prepare(
          "SELECT key_hash, request_hash, email_id, expires_at FROM idempotency_claims WHERE key_hash = ? AND expires_at > ?",
        )
        .bind(idempotency.key_hash, nowEpochSeconds),
    );
    if (!claim) {
      return undefined;
    }
    if (claim.request_hash !== idempotency.request_hash) {
      throw new ConflictError(
        "The Idempotency-Key has already been used with a different request.",
      );
    }
    const replay = await this.getDelivery(claim.email_id);
    if (!replay) {
      throw new ConflictError(
        "The idempotent delivery exists but its atomic records are unavailable.",
      );
    }
    return {
      ...replay,
      idempotency: structuredClone(idempotency),
      replayed: true,
    };
  }

  private async getStoredDeliveryState(
    messageId: string,
  ): Promise<StoredDeliveryState | undefined> {
    const [header, recipientRows, attemptRows] = await Promise.all([
      this.first<LedgerHeaderRow>(
        "read",
        "ledger-header",
        this.database
          .prepare(
            "SELECT e.entity AS email_entity, m.entity AS message_entity, v.revision AS revision FROM emails e JOIN delivery_messages m ON m.id = e.id JOIN delivery_ledger_versions v ON v.message_id = m.id WHERE e.id = ?",
          )
          .bind(messageId),
      ),
      this.all<EntityRow>(
        "read",
        "ledger-recipients",
        this.database
          .prepare(
            "SELECT entity FROM delivery_recipients WHERE message_id = ? ORDER BY role, ordinal, id",
          )
          .bind(messageId),
      ),
      this.all<EntityRow>(
        "read",
        "ledger-attempts",
        this.database
          .prepare(
            "SELECT entity FROM delivery_attempts WHERE message_id = ? ORDER BY sequence, id",
          )
          .bind(messageId),
      ),
    ]);
    if (!header) {
      return undefined;
    }
    const message = deliveryMessageRecordSchema.parse(
      JSON.parse(header.message_entity),
    );
    const recipientById = new Map(
      recipientRows.results
        .map((row) => recipientRecordSchema.parse(JSON.parse(row.entity)))
        .map((recipient) => [recipient.id, recipient]),
    );
    const recipients = message.recipient_ids
      .map((id) => recipientById.get(id))
      .filter(
        (recipient): recipient is RecipientRecord =>
          recipient !== undefined,
      );
    if (recipients.length !== message.recipient_ids.length) {
      return undefined;
    }
    return {
      revision: Number(header.revision),
      snapshot: {
        email: JSON.parse(header.email_entity) as EmailRecord,
        message,
        recipients,
        attempts: attemptRows.results.map((row) =>
          deliveryAttemptRecordSchema.parse(JSON.parse(row.entity)),
        ),
      },
    };
  }

  private async commitLedgerPlan(
    stored: StoredDeliveryState,
    plan: DeliveryLedgerPlan,
    addition: {
      operation: string;
      put_attempt?: DeliveryAttemptRecord | undefined;
      update_attempt?: DeliveryAttemptRecord | undefined;
      put_event?: ProviderEventRecord | undefined;
    },
  ): Promise<void> {
    const operationId = `ledger:v1:${plan.message.id}:${stored.revision}:${addition.operation}`;
    const statements: D1PreparedStatement[] = [];
    await this.stageWrite(
      statements,
      "ledger",
      "guard",
      this.database
        .prepare(
          "INSERT INTO delivery_ledger_mutations(operation_id, message_id, expected_revision, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(
          operationId,
          plan.message.id,
          stored.revision,
          plan.message.updated_at,
        ),
    );
    await this.stageWrite(
      statements,
      "ledger",
      "email",
      this.database
        .prepare(
          "UPDATE emails SET entity = ?, updated_at = ? WHERE id = ?",
        )
        .bind(json(plan.email), plan.email.updated_at, plan.email.id),
    );
    await this.stageWrite(
      statements,
      "ledger",
      "message",
      this.database
        .prepare(
          "UPDATE delivery_messages SET entity = ?, updated_at = ? WHERE id = ?",
        )
        .bind(
          json(plan.message),
          plan.message.updated_at,
          plan.message.id,
        ),
    );
    for (const [index, recipient] of plan.recipients.entries()) {
      await this.stageWrite(
        statements,
        "ledger",
        "recipient",
        this.database
          .prepare(
            "UPDATE delivery_recipients SET entity = ?, updated_at = ? WHERE id = ? AND message_id = ?",
          )
          .bind(
            json(recipient),
            recipient.updated_at,
            recipient.id,
            recipient.message_id,
          ),
        index,
      );
    }
    if (addition.put_attempt) {
      await this.stageWrite(
        statements,
        "ledger",
        "attempt-insert",
        this.database
          .prepare(
            "INSERT INTO delivery_attempts(id, message_id, sequence, provider, provider_message_id, entity) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            addition.put_attempt.id,
            addition.put_attempt.message_id,
            addition.put_attempt.sequence,
            addition.put_attempt.provider.name,
            addition.put_attempt.provider_message_id ?? null,
            json(addition.put_attempt),
          ),
      );
    }
    if (addition.update_attempt) {
      await this.stageWrite(
        statements,
        "ledger",
        "attempt-update",
        this.database
          .prepare(
            "UPDATE delivery_attempts SET provider = ?, provider_message_id = ?, entity = ? WHERE id = ? AND message_id = ?",
          )
          .bind(
            addition.update_attempt.provider.name,
            addition.update_attempt.provider_message_id ?? null,
            json(addition.update_attempt),
            addition.update_attempt.id,
            addition.update_attempt.message_id,
          ),
      );
    }
    if (addition.put_event) {
      await this.stageWrite(
        statements,
        "ledger",
        "provider-event",
        this.database
          .prepare(
            "INSERT INTO provider_events(id, message_id, received_at, entity) VALUES (?, ?, ?, ?)",
          )
          .bind(
            addition.put_event.id,
            addition.put_event.message_id,
            addition.put_event.received_at,
            json(addition.put_event),
          ),
      );
      await this.stageWrite(
        statements,
        "ledger",
        "provider-event-metrics",
        this.database
          .prepare(
            "UPDATE provider_event_metrics SET latest_received_at = CASE WHEN latest_received_at IS NULL OR latest_received_at < ? THEN ? ELSE latest_received_at END WHERE singleton = 1",
          )
          .bind(
            addition.put_event.received_at,
            addition.put_event.received_at,
          ),
      );
    }
    await this.stageWrite(
      statements,
      "ledger",
      "version",
      this.database
        .prepare(
          "UPDATE delivery_ledger_versions SET revision = revision + 1 WHERE message_id = ? AND revision = ?",
        )
        .bind(plan.message.id, stored.revision),
    );
    await this.executeBatch("ledger", operationId, statements);
  }

  private async commitOwnedOutboxMutation(
    action: "acknowledge" | "failure",
    updated: OutboxItemRecord,
    owner: string,
    nowIso: string,
  ): Promise<boolean> {
    const operationId = `outbox:v1:${updated.id}:${action}:${updated.attempts}:${nowIso}`;
    const statements: D1PreparedStatement[] = [];
    await this.stageWrite(
      statements,
      action,
      "guard",
      this.database
        .prepare(
          "INSERT INTO outbox_mutations(operation_id, outbox_id, expected_owner, action, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(operationId, updated.id, owner, action, nowIso),
    );
    await this.stageWrite(
      statements,
      action,
      "outbox",
      this.database
        .prepare(
          "UPDATE outbox_items SET lease_owner = NULL, lease_expires_at = NULL, dispatched_at = ?, last_diagnostic_category = ?, entity = ?, updated_at = ? WHERE id = ?",
        )
        .bind(
          updated.dispatched_at ?? null,
          updated.last_diagnostic_category ?? null,
          json(updated),
          updated.updated_at,
          updated.id,
        ),
    );
    if (action === "failure") {
      await this.stageWrite(
        statements,
        action,
        "metrics",
        this.database.prepare(
          "UPDATE outbox_metrics SET publish_failures_total = publish_failures_total + 1 WHERE singleton = 1",
        ),
      );
    }
    try {
      await this.executeBatch(action, updated.id, statements);
      return true;
    } catch (error) {
      if (constraintFailure(error)) {
        return false;
      }
      throw error;
    }
  }

  private async providerEventReplay(
    existing: ProviderEventRecord,
    input: ProviderEventRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    if (!isEquivalentProviderEventReplay(existing, input)) {
      throw new ConflictError(
        "Provider event identity is already used by a different normalized event.",
      );
    }
    return this.deliveryLedgerResult(existing.message_id, true, [], {
      event: existing,
    });
  }

  private async deliveryLedgerResult(
    messageId: string,
    replayed: boolean,
    changedRecipientIds: string[],
    addition: {
      attempt?: DeliveryAttemptRecord | undefined;
      event?: ProviderEventRecord | undefined;
    } = {},
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const snapshot = await this.getDeliveryLedger(messageId);
    if (!snapshot) {
      return undefined;
    }
    return {
      ...snapshot,
      replayed,
      changed_recipient_ids: [...changedRecipientIds],
      ...(addition.attempt
        ? { attempt: structuredClone(addition.attempt) }
        : {}),
      ...(addition.event
        ? { event: structuredClone(addition.event) }
        : {}),
    };
  }

  private async stageWrite(
    statements: D1PreparedStatement[],
    operation: string,
    target: string,
    statement: D1PreparedStatement,
    index?: number,
  ): Promise<void> {
    await injectCloudflareFault(this.options.fault_injector, {
      component: "d1",
      operation,
      target,
      ...(index === undefined ? {} : { index }),
    });
    statements.push(statement);
  }

  private async executeBatch(
    operation: string,
    target: string,
    statements: D1PreparedStatement[],
  ): Promise<D1Result[]> {
    await injectCloudflareFault(this.options.fault_injector, {
      component: "d1",
      operation: `${operation}-batch`,
      target,
    });
    return this.database.batch(statements);
  }

  private async first<T>(
    operation: string,
    target: string,
    statement: D1PreparedStatement,
  ): Promise<T | null> {
    await injectCloudflareFault(this.options.fault_injector, {
      component: "d1",
      operation,
      target,
    });
    return statement.first<T>();
  }

  private async all<T>(
    operation: string,
    target: string,
    statement: D1PreparedStatement,
  ): Promise<D1Result<T>> {
    await injectCloudflareFault(this.options.fault_injector, {
      component: "d1",
      operation,
      target,
    });
    return statement.all<T>();
  }
}
