import type { Pool, PoolClient, QueryResultRow } from "pg";
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

type Queryable = Pick<Pool | PoolClient, "query">;

interface EntityRow extends QueryResultRow {
  entity: unknown;
}

interface DeliveryHeaderRow extends QueryResultRow {
  email_entity: unknown;
  message_entity: unknown;
}

interface IdempotencyRow extends QueryResultRow {
  key_hash: string;
  request_hash: string;
  email_id: string;
  expires_at: string;
}

interface OutboxMetricsRow extends QueryResultRow {
  due: string;
  leased: string;
  stuck_leases: string;
  undispatched: string;
  oldest_due_age_seconds: string | null;
  publish_failures_total: string;
}

interface StoredLedgerState {
  email: EmailRecord;
  message: DeliveryMessageRecord;
  recipients: RecipientRecord[];
  attempts: DeliveryAttemptRecord[];
}

function parseEntity<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
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

export class PostgresDeliveryStore
  implements DeliveryOutboxStore, DeliveryLedgerStore
{
  constructor(private readonly pool: Pool) {}

  async commitDelivery(
    input: DeliveryCommit,
    nowEpochSeconds: number,
  ): Promise<DeliveryCommitResult> {
    const validated = validateDeliveryCommit(input, nowEpochSeconds);
    if (validated.idempotency) {
      const replay = await this.replayForIdempotency(
        validated.idempotency,
        nowEpochSeconds,
      );
      if (replay) {
        return replay;
      }
    }

    try {
      await this.withTransaction(async (client) => {
        if (validated.idempotency) {
          await client.query(
            "DELETE FROM idempotency_claims WHERE key_hash = $1 AND expires_at <= $2",
            [validated.idempotency.key_hash, nowEpochSeconds],
          );
        }
        await client.query(
          "INSERT INTO emails(id, entity, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $4)",
          [
            validated.email.id,
            JSON.stringify(validated.email),
            validated.email.created_at,
            validated.email.updated_at,
          ],
        );
        await client.query(
          "INSERT INTO delivery_messages(id, entity, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $4)",
          [
            validated.message.id,
            JSON.stringify(validated.message),
            validated.message.created_at,
            validated.message.updated_at,
          ],
        );
        for (const recipient of validated.recipients) {
          await client.query(
            "INSERT INTO delivery_recipients(id, message_id, role, ordinal, entity, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
            [
              recipient.id,
              recipient.message_id,
              recipient.role,
              recipient.ordinal,
              JSON.stringify(recipient),
              recipient.created_at,
              recipient.updated_at,
            ],
          );
        }
        await client.query(
          "INSERT INTO outbox_items(id, message_id, due_at, lease_owner, lease_expires_at, dispatched_at, attempts, last_diagnostic_category, entity, created_at, updated_at) VALUES ($1, $2, $3, NULL, NULL, $4, $5, NULL, $6::jsonb, $7, $8)",
          [
            validated.outbox.id,
            validated.outbox.message_id,
            validated.outbox.due_at,
            validated.outbox.dispatched_at ?? null,
            validated.outbox.attempts,
            JSON.stringify(validated.outbox),
            validated.outbox.created_at,
            validated.outbox.updated_at,
          ],
        );
        if (validated.idempotency) {
          await client.query(
            "INSERT INTO idempotency_claims(key_hash, request_hash, email_id, expires_at) VALUES ($1, $2, $3, $4)",
            [
              validated.idempotency.key_hash,
              validated.idempotency.request_hash,
              validated.email.id,
              validated.idempotency.expires_at,
            ],
          );
        }
      });
      return { ...validated, replayed: false };
    } catch (error) {
      if (validated.idempotency && isUniqueViolation(error)) {
        const replay = await this.replayForIdempotency(
          validated.idempotency,
          nowEpochSeconds,
        );
        if (replay) {
          return replay;
        }
      }
      if (isUniqueViolation(error)) {
        throw new ConflictError("Delivery identity is already in use.");
      }
      throw error;
    }
  }

  async getDelivery(
    messageId: string,
  ): Promise<DeliveryCommitResult | undefined> {
    return this.getDeliveryUsing(this.pool, messageId);
  }

  async getDeliveryLedger(
    messageId: string,
  ): Promise<DeliveryLedgerSnapshot | undefined> {
    return this.getDeliveryLedgerUsing(this.pool, messageId);
  }

  async beginDeliveryAttempt(
    input: DeliveryAttemptRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const attempt = deliveryAttemptRecordSchema.parse(input);
    try {
      return await this.withTransaction(async (client) => {
        const stored = await this.getStoredLedgerState(
          client,
          attempt.message_id,
          true,
        );
        if (!stored) {
          return undefined;
        }
        const existing = stored.attempts.find(
          (candidate) =>
            candidate.id === attempt.id ||
            candidate.sequence === attempt.sequence,
        );
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(attempt)) {
            throw new ConflictError(
              "Delivery attempt identity or sequence is already in use.",
            );
          }
          return this.deliveryLedgerResult(
            client,
            attempt.message_id,
            true,
            [],
            { attempt: existing },
          );
        }
        const plan = planAttemptStart(stored, attempt);
        await this.applyLedgerPlan(client, plan);
        await client.query(
          "INSERT INTO delivery_attempts(id, message_id, sequence, provider, provider_message_id, entity) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
          [
            attempt.id,
            attempt.message_id,
            attempt.sequence,
            attempt.provider.name,
            attempt.provider_message_id ?? null,
            JSON.stringify(attempt),
          ],
        );
        return this.deliveryLedgerResult(
          client,
          attempt.message_id,
          false,
          plan.changed_recipient_ids,
          { attempt },
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "Delivery attempt identity or sequence is already in use.",
        );
      }
      throw error;
    }
  }

  async completeDeliveryAttempt(
    input: AttemptCompletion,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    return this.withTransaction(async (client) => {
      const stored = await this.getStoredLedgerState(
        client,
        input.message_id,
        true,
      );
      if (!stored) {
        return undefined;
      }
      const existing = stored.attempts.find(
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
        return this.deliveryLedgerResult(client, input.message_id, true, [], {
          attempt: existing,
        });
      }
      const plan = planAttemptCompletion(stored, input);
      await this.applyLedgerPlan(client, plan);
      await client.query(
        "UPDATE delivery_attempts SET provider_message_id = $1, entity = $2::jsonb WHERE id = $3 AND message_id = $4",
        [
          plan.attempt.provider_message_id ?? null,
          JSON.stringify(plan.attempt),
          plan.attempt.id,
          plan.attempt.message_id,
        ],
      );
      return this.deliveryLedgerResult(
        client,
        input.message_id,
        false,
        plan.changed_recipient_ids,
        { attempt: plan.attempt },
      );
    });
  }

  async appendProviderEvent(
    input: ProviderEventRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const event = providerEventRecordSchema.parse(input);
    try {
      return await this.withTransaction(async (client) => {
        const stored = await this.getStoredLedgerState(
          client,
          event.message_id,
          true,
        );
        if (!stored) {
          return undefined;
        }
        const existing = await this.getProviderEventUsing(client, event.id);
        if (existing) {
          return this.providerEventReplay(client, existing, event);
        }
        const plan = planProviderEvent(stored, event);
        await this.applyLedgerPlan(client, plan);
        await client.query(
          "INSERT INTO provider_events(id, message_id, received_at, entity) VALUES ($1, $2, $3, $4::jsonb)",
          [
            event.id,
            event.message_id,
            event.received_at,
            JSON.stringify(event),
          ],
        );
        await client.query(
          "UPDATE provider_event_metrics SET latest_received_at = GREATEST(COALESCE(latest_received_at, $1::timestamptz), $1::timestamptz) WHERE singleton = true",
          [event.received_at],
        );
        return this.deliveryLedgerResult(
          client,
          event.message_id,
          false,
          plan.changed_recipient_ids,
          { event },
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.getProviderEvent(event.id);
        if (existing) {
          return this.providerEventReplay(this.pool, existing, event);
        }
      }
      throw error;
    }
  }

  async applyLocalDeliveryState(
    messageId: string,
    status: "canceled" | "suppressed",
    updatedAt: string,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    return this.withTransaction(async (client) => {
      const stored = await this.getStoredLedgerState(client, messageId, true);
      if (!stored) {
        return undefined;
      }
      const plan = planLocalRecipientState(stored, status, updatedAt);
      await this.applyLedgerPlan(client, plan);
      return this.deliveryLedgerResult(
        client,
        messageId,
        false,
        plan.changed_recipient_ids,
      );
    });
  }

  async getProviderEvent(id: string): Promise<ProviderEventRecord | undefined> {
    return this.getProviderEventUsing(this.pool, id);
  }

  async getLatestProviderEventReceivedAt(): Promise<string | undefined> {
    const result = await this.pool.query<{
      latest_received_at: Date | null;
    }>(
      "SELECT latest_received_at FROM provider_event_metrics WHERE singleton = true",
    );
    return result.rows[0]?.latest_received_at?.toISOString();
  }

  async getOutboxItem(id: string): Promise<OutboxItemRecord | undefined> {
    const result = await this.pool.query<EntityRow>(
      "SELECT entity FROM outbox_items WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? outboxItemRecordSchema.parse(parseEntity(row.entity))
      : undefined;
  }

  async leaseDueOutbox(
    input: LeaseDueOutboxInput,
  ): Promise<OutboxItemRecord[]> {
    validateLeaseInput(input);
    const nowIso = input.now.toISOString();
    const leaseExpiresAt = new Date(
      input.now.getTime() + input.lease_seconds * 1_000,
    ).toISOString();
    return this.withTransaction(async (client) => {
      const result = await client.query<EntityRow>(
        `WITH candidates AS (
           SELECT id
           FROM outbox_items
           WHERE dispatched_at IS NULL
             AND due_at <= ($1::text)::timestamptz
             AND (
               lease_expires_at IS NULL
               OR lease_expires_at <= ($1::text)::timestamptz
             )
           ORDER BY due_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE outbox_items AS outbox
         SET lease_owner = $3,
             lease_expires_at = ($4::text)::timestamptz,
             attempts = outbox.attempts + 1,
             updated_at = ($1::text)::timestamptz,
             entity = outbox.entity || jsonb_build_object(
               'attempts', outbox.attempts + 1,
               'lease_owner', $3::text,
               'lease_expires_at', $4::text,
               'updated_at', $1::text
             )
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.entity`,
        [nowIso, input.limit, input.owner, leaseExpiresAt],
      );
      return result.rows.map((row) =>
        outboxItemRecordSchema.parse(parseEntity(row.entity)),
      );
    });
  }

  async acknowledgeOutbox(
    id: string,
    owner: string,
    now: Date,
  ): Promise<boolean> {
    const nowIso = now.toISOString();
    const result = await this.pool.query(
      `UPDATE outbox_items
       SET lease_owner = NULL,
           lease_expires_at = NULL,
           dispatched_at = ($3::text)::timestamptz,
           updated_at = ($3::text)::timestamptz,
           entity = (entity - 'lease_owner' - 'lease_expires_at')
             || jsonb_build_object(
               'dispatched_at', $3::text,
               'updated_at', $3::text
             )
       WHERE id = $1
         AND dispatched_at IS NULL
         AND lease_owner = $2`,
      [id, owner, nowIso],
    );
    return result.rowCount === 1;
  }

  async recordOutboxFailure(
    id: string,
    owner: string,
    category: DeliveryDiagnosticCategory,
    now: Date,
  ): Promise<boolean> {
    const diagnostic = deliveryDiagnosticCategorySchema.parse(category);
    const nowIso = now.toISOString();
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE outbox_items
         SET lease_owner = NULL,
             lease_expires_at = NULL,
             last_diagnostic_category = $3,
             updated_at = ($4::text)::timestamptz,
             entity = (entity - 'lease_owner' - 'lease_expires_at')
               || jsonb_build_object(
                 'last_diagnostic_category', $3::text,
                 'updated_at', $4::text
               )
         WHERE id = $1
           AND dispatched_at IS NULL
           AND lease_owner = $2`,
        [id, owner, diagnostic, nowIso],
      );
      if (result.rowCount !== 1) {
        return false;
      }
      await client.query(
        "UPDATE outbox_metrics SET publish_failures_total = publish_failures_total + 1 WHERE singleton = true",
      );
      return true;
    });
  }

  async getOutboxMetrics(now: Date): Promise<OutboxMetrics> {
    const result = await this.pool.query<OutboxMetricsRow>(
      `SELECT
         COUNT(*) FILTER (
           WHERE dispatched_at IS NULL
             AND due_at <= $1
             AND (
               lease_expires_at IS NULL
               OR lease_expires_at <= $1
             )
         )::text AS due,
         COUNT(*) FILTER (
           WHERE dispatched_at IS NULL
             AND due_at <= $1
             AND lease_expires_at > $1
         )::text AS leased,
         COUNT(*) FILTER (
           WHERE dispatched_at IS NULL
             AND due_at <= $1
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= $1
         )::text AS stuck_leases,
         COUNT(*) FILTER (WHERE dispatched_at IS NULL)::text AS undispatched,
         EXTRACT(
           EPOCH FROM (
             $1::timestamptz
             - MIN(due_at) FILTER (
               WHERE dispatched_at IS NULL AND due_at <= $1
             )
           )
         )::text AS oldest_due_age_seconds,
         metrics.publish_failures_total::text AS publish_failures_total
       FROM outbox_metrics AS metrics
       LEFT JOIN outbox_items ON true
       WHERE metrics.singleton = true
       GROUP BY metrics.publish_failures_total`,
      [now.toISOString()],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("PostgreSQL outbox metrics singleton is missing.");
    }
    return {
      due: Number(row.due),
      leased: Number(row.leased),
      stuck_leases: Number(row.stuck_leases),
      undispatched: Number(row.undispatched),
      oldest_due_age_seconds: Math.max(
        0,
        Math.floor(Number(row.oldest_due_age_seconds ?? 0)),
      ),
      publish_failures_total: Number(row.publish_failures_total),
      truncated: false,
    };
  }

  private async replayForIdempotency(
    idempotency: IdempotencyClaim,
    nowEpochSeconds: number,
  ): Promise<DeliveryCommitResult | undefined> {
    const result = await this.pool.query<IdempotencyRow>(
      "SELECT key_hash, request_hash, email_id, expires_at::text FROM idempotency_claims WHERE key_hash = $1 AND expires_at > $2",
      [idempotency.key_hash, nowEpochSeconds],
    );
    const claim = result.rows[0];
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

  private async getDeliveryUsing(
    queryable: Queryable,
    messageId: string,
  ): Promise<DeliveryCommitResult | undefined> {
    const header = await queryable.query<DeliveryHeaderRow>(
      "SELECT email.entity AS email_entity, message.entity AS message_entity FROM emails AS email JOIN delivery_messages AS message ON message.id = email.id WHERE email.id = $1",
      [messageId],
    );
    const recipients = await queryable.query<EntityRow>(
      "SELECT entity FROM delivery_recipients WHERE message_id = $1 ORDER BY role, ordinal, id",
      [messageId],
    );
    const outbox = await queryable.query<EntityRow>(
      "SELECT entity FROM outbox_items WHERE message_id = $1",
      [messageId],
    );
    const claim = await queryable.query<IdempotencyRow>(
      "SELECT key_hash, request_hash, email_id, expires_at::text FROM idempotency_claims WHERE email_id = $1 ORDER BY expires_at DESC LIMIT 1",
      [messageId],
    );
    const headerRow = header.rows[0];
    const outboxRow = outbox.rows[0];
    if (!headerRow || !outboxRow) {
      return undefined;
    }
    const message = deliveryMessageRecordSchema.parse(
      parseEntity(headerRow.message_entity),
    );
    const recipientById = new Map(
      recipients.rows
        .map((row) => recipientRecordSchema.parse(parseEntity(row.entity)))
        .map((recipient) => [recipient.id, recipient]),
    );
    const orderedRecipients = message.recipient_ids
      .map((id) => recipientById.get(id))
      .filter(
        (recipient): recipient is RecipientRecord => recipient !== undefined,
      );
    if (orderedRecipients.length !== message.recipient_ids.length) {
      return undefined;
    }
    const claimRow = claim.rows[0];
    return {
      email: parseEntity<EmailRecord>(headerRow.email_entity),
      message,
      recipients: orderedRecipients,
      outbox: outboxItemRecordSchema.parse(parseEntity(outboxRow.entity)),
      ...(claimRow
        ? {
            idempotency: {
              key_hash: claimRow.key_hash,
              request_hash: claimRow.request_hash,
              expires_at: Number(claimRow.expires_at),
            },
          }
        : {}),
      replayed: false,
    };
  }

  private async getStoredLedgerState(
    queryable: Queryable,
    messageId: string,
    lock: boolean,
  ): Promise<StoredLedgerState | undefined> {
    const header = await queryable.query<DeliveryHeaderRow>(
      `SELECT email.entity AS email_entity,
              message.entity AS message_entity
       FROM emails AS email
       JOIN delivery_messages AS message ON message.id = email.id
       WHERE email.id = $1
       ${lock ? "FOR UPDATE OF email, message" : ""}`,
      [messageId],
    );
    const headerRow = header.rows[0];
    if (!headerRow) {
      return undefined;
    }
    const recipients = await queryable.query<EntityRow>(
      "SELECT entity FROM delivery_recipients WHERE message_id = $1 ORDER BY role, ordinal, id",
      [messageId],
    );
    const attempts = await queryable.query<EntityRow>(
      "SELECT entity FROM delivery_attempts WHERE message_id = $1 ORDER BY sequence, id",
      [messageId],
    );
    const message = deliveryMessageRecordSchema.parse(
      parseEntity(headerRow.message_entity),
    );
    const recipientById = new Map(
      recipients.rows
        .map((row) => recipientRecordSchema.parse(parseEntity(row.entity)))
        .map((recipient) => [recipient.id, recipient]),
    );
    const orderedRecipients = message.recipient_ids
      .map((id) => recipientById.get(id))
      .filter(
        (recipient): recipient is RecipientRecord => recipient !== undefined,
      );
    if (orderedRecipients.length !== message.recipient_ids.length) {
      return undefined;
    }
    return {
      email: parseEntity<EmailRecord>(headerRow.email_entity),
      message,
      recipients: orderedRecipients,
      attempts: attempts.rows.map((row) =>
        deliveryAttemptRecordSchema.parse(parseEntity(row.entity)),
      ),
    };
  }

  private async getDeliveryLedgerUsing(
    queryable: Queryable,
    messageId: string,
  ): Promise<DeliveryLedgerSnapshot | undefined> {
    const stored = await this.getStoredLedgerState(queryable, messageId, false);
    const events = await queryable.query<EntityRow>(
      "SELECT entity FROM provider_events WHERE message_id = $1 ORDER BY received_at, id",
      [messageId],
    );
    if (!stored) {
      return undefined;
    }
    return {
      ...stored,
      events: events.rows.map((row) =>
        providerEventRecordSchema.parse(parseEntity(row.entity)),
      ),
    };
  }

  private async getProviderEventUsing(
    queryable: Queryable,
    id: string,
  ): Promise<ProviderEventRecord | undefined> {
    const result = await queryable.query<EntityRow>(
      "SELECT entity FROM provider_events WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? providerEventRecordSchema.parse(parseEntity(row.entity))
      : undefined;
  }

  private async applyLedgerPlan(
    client: PoolClient,
    plan: DeliveryLedgerPlan,
  ): Promise<void> {
    await client.query(
      "UPDATE emails SET entity = $1::jsonb, updated_at = $2 WHERE id = $3",
      [JSON.stringify(plan.email), plan.email.updated_at, plan.email.id],
    );
    await client.query(
      "UPDATE delivery_messages SET entity = $1::jsonb, updated_at = $2 WHERE id = $3",
      [JSON.stringify(plan.message), plan.message.updated_at, plan.message.id],
    );
    for (const recipient of plan.recipients) {
      await client.query(
        "UPDATE delivery_recipients SET entity = $1::jsonb, updated_at = $2 WHERE id = $3 AND message_id = $4",
        [
          JSON.stringify(recipient),
          recipient.updated_at,
          recipient.id,
          recipient.message_id,
        ],
      );
    }
  }

  private async providerEventReplay(
    queryable: Queryable,
    existing: ProviderEventRecord,
    input: ProviderEventRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    if (!isEquivalentProviderEventReplay(existing, input)) {
      throw new ConflictError(
        "Provider event identity is already used by a different normalized event.",
      );
    }
    return this.deliveryLedgerResult(queryable, existing.message_id, true, [], {
      event: existing,
    });
  }

  private async deliveryLedgerResult(
    queryable: Queryable,
    messageId: string,
    replayed: boolean,
    changedRecipientIds: string[],
    addition: {
      attempt?: DeliveryAttemptRecord | undefined;
      event?: ProviderEventRecord | undefined;
    } = {},
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const snapshot = await this.getDeliveryLedgerUsing(queryable, messageId);
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
      ...(addition.event ? { event: structuredClone(addition.event) } : {}),
    };
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
