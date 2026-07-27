import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { validateDeliveryCommit } from "../core/delivery-commit.js";
import {
  createOutboxIdentity,
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
} from "../core/delivery-model.js";
import { ConflictError, ValidationError } from "../core/errors.js";
import {
  planAttemptCompletion,
  planAttemptStart,
  planLocalRecipientState,
  planProviderEvent,
  type AttemptCompletion,
  type DeliveryLedgerPlan,
} from "../core/recipient-ledger.js";
import type {
  ApiKeyRecord,
  AttachmentUploadRecord,
  CreateEmailResult,
  DomainRecord,
  EmailRecord,
  EmailStatus,
  IdempotencyClaim,
  Page,
  ReceivedEmailRecord,
  SuppressionRecord,
  TemplatePublicationRecord,
  TemplateRecord,
  WebhookDeliveryRecord,
  WebhookEndpoint,
} from "../core/types.js";
import { safeErrorCategory } from "../core/error-telemetry.js";
import type {
  DeliveryCommit,
  DeliveryCommitResult,
  DeliveryOutboxStore,
  LeaseDueOutboxInput,
  OutboxMetrics,
} from "../ports/delivery-outbox-store.js";
import type {
  DeliveryLedgerMutationResult,
  DeliveryLedgerSnapshot,
} from "../ports/delivery-ledger-store.js";
import type { Store } from "../ports/store.js";

type Entity =
  | EmailRecord
  | AttachmentUploadRecord
  | DomainRecord
  | WebhookEndpoint
  | WebhookDeliveryRecord
  | ApiKeyRecord
  | SuppressionRecord
  | ReceivedEmailRecord
  | TemplateRecord
  | DeliveryMessageRecord
  | RecipientRecord
  | OutboxItemRecord;
type EntityKind =
  | "EMAIL"
  | "ATTACHMENT"
  | "RECEIVED"
  | "RECEIVED_CLAIM"
  | "DOMAIN"
  | "WEBHOOK"
  | "WEBHOOK_DELIVERY"
  | "APIKEY"
  | "SUPPRESSION"
  | "TEMPLATE"
  | "TEMPLATE_ALIAS"
  | "TEMPLATE_PUBLISHED_ALIAS";
type IndexedEntityKind = Exclude<
  EntityKind,
  | "ATTACHMENT"
  | "RECEIVED_CLAIM"
  | "WEBHOOK_DELIVERY"
  | "TEMPLATE_ALIAS"
  | "TEMPLATE_PUBLISHED_ALIAS"
>;
type IndexPartition =
  | "EMAILS"
  | "RECEIVED_EMAILS"
  | "DOMAINS"
  | "WEBHOOKS"
  | "API_KEYS"
  | "SUPPRESSIONS"
  | "TEMPLATES";

interface StoredEntity {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entity: Entity;
  ttl?: number;
  email_id?: string;
  request_hash?: string;
}

interface StoredTemplatePublication {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entity: TemplatePublicationRecord;
  ttl: number;
}

interface StoredDeliveryRecord<T> {
  PK: string;
  SK: string;
  entity: T;
}

interface StoredOutboxItem extends StoredDeliveryRecord<OutboxItemRecord> {
  GSI1PK?: string | undefined;
  GSI1SK?: string | undefined;
}

interface StoredProviderEvent
  extends StoredDeliveryRecord<ProviderEventRecord> {
  GSI1PK: string;
  GSI1SK: string;
}

interface StoredDeliveryState {
  emailItem: StoredEntity;
  messageItem: StoredDeliveryRecord<DeliveryMessageRecord>;
  recipientItems: Map<string, StoredDeliveryRecord<RecipientRecord>>;
  attemptItems: Map<string, StoredDeliveryRecord<DeliveryAttemptRecord>>;
  snapshot: Omit<DeliveryLedgerSnapshot, "events">;
}

interface StoredOutboxMetrics {
  PK: string;
  SK: string;
  undispatched?: number | undefined;
  publish_failures_total?: number | undefined;
  updated_at?: string | undefined;
}

interface StoredProviderEventMetrics {
  PK: string;
  SK: string;
  latest_received_at?: string | undefined;
}

const OUTBOX_DUE_PARTITION = "OUTBOX_DUE";
const OUTBOX_LEASED_PARTITION = "OUTBOX_LEASED";
const OUTBOX_METRIC_QUERY_LIMIT = 1_000;
const DELIVERY_LEDGER_RETRIES = 8;

const INDEX_PARTITION: Record<IndexedEntityKind, IndexPartition> = {
  EMAIL: "EMAILS",
  RECEIVED: "RECEIVED_EMAILS",
  DOMAIN: "DOMAINS",
  WEBHOOK: "WEBHOOKS",
  APIKEY: "API_KEYS",
  SUPPRESSION: "SUPPRESSIONS",
  TEMPLATE: "TEMPLATES",
};

function entityKey(kind: EntityKind, id: string) {
  return { PK: `${kind}#${id}`, SK: `${kind}#${id}` };
}

function deliveryMessageKey(messageId: string) {
  return {
    PK: `EMAIL#${messageId}`,
    SK: `DELIVERY_MESSAGE#${messageId}`,
  };
}

function recipientKey(messageId: string, recipientId: string) {
  return {
    PK: `EMAIL#${messageId}`,
    SK: `RECIPIENT#${recipientId}`,
  };
}

function attemptKey(messageId: string, sequence: number) {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error("Delivery attempt sequence must be a positive integer.");
  }
  return {
    PK: `EMAIL#${messageId}`,
    SK: `ATTEMPT#${String(sequence).padStart(10, "0")}`,
  };
}

function providerEventKey(id: string) {
  return {
    PK: `PROVIDER_EVENT#${id}`,
    SK: `PROVIDER_EVENT#${id}`,
  };
}

function storedProviderEvent(
  record: ProviderEventRecord,
): StoredProviderEvent {
  return {
    ...providerEventKey(record.id),
    GSI1PK: `DELIVERY_EVENTS#${record.message_id}`,
    GSI1SK: `${record.received_at}#${record.id}`,
    entity: record,
  };
}

function outboxKey(id: string) {
  return { PK: `OUTBOX#${id}`, SK: `OUTBOX#${id}` };
}

function outboxMetricsKey() {
  return { PK: "OUTBOX_METRICS", SK: "OUTBOX_METRICS" };
}

function providerEventMetricsKey() {
  return {
    PK: "PROVIDER_EVENT_METRICS",
    SK: "PROVIDER_EVENT_METRICS",
  };
}

function outboxSort(availableAt: string, id: string) {
  return `${availableAt}#${id}`;
}

function storedOutboxItem(record: OutboxItemRecord): StoredOutboxItem {
  return {
    ...outboxKey(record.id),
    ...(record.dispatched_at === undefined
      ? {
          GSI1PK: OUTBOX_DUE_PARTITION,
          GSI1SK: outboxSort(record.due_at, record.id),
        }
      : {}),
    entity: record,
  };
}

function templateVersionKey(templateId: string, versionId: string) {
  return {
    PK: `TEMPLATE_VERSION#${templateId}`,
    SK: `TEMPLATE_VERSION#${versionId}`,
  };
}

function storedTemplatePublication(
  record: TemplatePublicationRecord,
): StoredTemplatePublication {
  return {
    ...templateVersionKey(record.template_id, record.id),
    GSI1PK: `TEMPLATE_VERSIONS#${record.template_id}`,
    GSI1SK: `${record.published_at}#${record.id}`,
    entity: record,
    ttl: Math.floor(Date.parse(record.expires_at) / 1_000),
  };
}

function storedEntity(kind: IndexedEntityKind, record: Entity): StoredEntity {
  const key = entityKey(kind, record.id);
  return {
    ...key,
    GSI1PK: INDEX_PARTITION[kind],
    GSI1SK: `${record.created_at}#${record.id}`,
    entity: record,
  };
}

export class DynamoStore implements Store, DeliveryOutboxStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly payloadBucket?: string,
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    private readonly s3 = new S3Client({}),
  ) {
    this.client = client;
  }

  async createEmail(
    record: EmailRecord,
    idempotency?: IdempotencyClaim,
  ): Promise<CreateEmailResult> {
    const persistedRecord = await this.externalizeEmailPayload(record);
    if (!idempotency) {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: storedEntity("EMAIL", persistedRecord),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { record, replayed: false };
    }

    const idempotencyKey = {
      PK: `IDEMPOTENCY#${idempotency.key_hash}`,
      SK: `IDEMPOTENCY#${idempotency.key_hash}`,
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: storedEntity("EMAIL", persistedRecord),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...idempotencyKey,
                  email_id: record.id,
                  request_hash: idempotency.request_hash,
                  ttl: idempotency.expires_at,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return { record, replayed: false };
    } catch (error) {
      if (
        (error as { name?: string }).name !== "TransactionCanceledException"
      ) {
        throw error;
      }
    }

    const existingClaim = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: idempotencyKey,
        ConsistentRead: true,
      }),
    );
    const claim = existingClaim.Item as StoredEntity | undefined;
    if (!claim || claim.request_hash !== idempotency.request_hash) {
      throw new ConflictError(
        "The Idempotency-Key has already been used with a different request.",
      );
    }
    if (!claim.email_id) {
      throw new ConflictError(
        "The idempotent request exists but its email record is unavailable.",
      );
    }
    const existingEmail = await this.getEmail(claim.email_id);
    if (!existingEmail) {
      throw new ConflictError(
        "The idempotent request exists but its email record is unavailable.",
      );
    }
    return { record: existingEmail, replayed: true };
  }

  async commitDelivery(
    input: DeliveryCommit,
    nowEpochSeconds: number,
  ): Promise<DeliveryCommitResult> {
    const validated = validateDeliveryCommit(input, nowEpochSeconds);
    const { email, message, recipients, outbox, idempotency } = validated;
    const persistedEmail = await this.externalizeEmailPayload(email);
    const transactItems: NonNullable<
      TransactWriteCommandInput["TransactItems"]
    > = [
      {
        Put: {
          TableName: this.tableName,
          Item: storedEntity("EMAIL", persistedEmail),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...deliveryMessageKey(message.id),
            entity: message,
          } satisfies StoredDeliveryRecord<DeliveryMessageRecord>,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      ...recipients.map((recipient) => ({
        Put: {
          TableName: this.tableName,
          Item: {
            ...recipientKey(message.id, recipient.id),
            entity: recipient,
          } satisfies StoredDeliveryRecord<RecipientRecord>,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      })),
      {
        Put: {
          TableName: this.tableName,
          Item: storedOutboxItem(outbox),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      ...(idempotency
        ? [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `IDEMPOTENCY#${idempotency.key_hash}`,
                  SK: `IDEMPOTENCY#${idempotency.key_hash}`,
                  email_id: email.id,
                  request_hash: idempotency.request_hash,
                  ttl: idempotency.expires_at,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ]
        : []),
      ...(outbox.dispatched_at === undefined
        ? [
            {
              Update: {
                TableName: this.tableName,
                Key: outboxMetricsKey(),
                UpdateExpression:
                  "SET updated_at = :updated ADD undispatched :one",
                ExpressionAttributeValues: {
                  ":updated": email.created_at,
                  ":one": 1,
                },
              },
            },
          ]
        : []),
    ];
    let transactionError: unknown;
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      );
      return { ...validated, replayed: false };
    } catch (error) {
      if (
        (error as { name?: string }).name !==
          "TransactionCanceledException" ||
        !idempotency
      ) {
        throw error;
      }
      transactionError = error;
    }

    const idempotencyKey = {
      PK: `IDEMPOTENCY#${idempotency.key_hash}`,
      SK: `IDEMPOTENCY#${idempotency.key_hash}`,
    };
    const existingClaim = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: idempotencyKey,
        ConsistentRead: true,
      }),
    );
    const claim = existingClaim.Item as
      | { email_id?: string; request_hash?: string }
      | undefined;
    if (!claim) {
      throw transactionError;
    }
    if (claim.request_hash !== idempotency.request_hash) {
      throw new ConflictError(
        "The Idempotency-Key has already been used with a different request.",
      );
    }
    if (!claim.email_id) {
      throw new ConflictError(
        "The idempotent delivery exists but its atomic records are unavailable.",
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

  async getDelivery(
    messageId: string,
  ): Promise<DeliveryCommitResult | undefined> {
    const outboxId = createOutboxIdentity({
      message_id: messageId,
      job_type: "dispatch-message",
      generation: 0,
    });
    const [email, messageResult, recipientsResult, outbox] =
      await Promise.all([
        this.getEmail(messageId),
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: deliveryMessageKey(messageId),
            ConsistentRead: true,
          }),
        ),
        this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression:
              "PK = :partition AND begins_with(SK, :recipient)",
            ExpressionAttributeValues: {
              ":partition": `EMAIL#${messageId}`,
              ":recipient": "RECIPIENT#",
            },
            ConsistentRead: true,
          }),
        ),
        this.getOutboxItem(outboxId),
      ]);
    const message = (
      messageResult.Item as
        | StoredDeliveryRecord<DeliveryMessageRecord>
        | undefined
    )?.entity;
    const unorderedRecipients = (recipientsResult.Items ?? []).map(
      (item) => (item as StoredDeliveryRecord<RecipientRecord>).entity,
    );
    if (
      !email ||
      !message ||
      !outbox ||
      unorderedRecipients.length === 0
    ) {
      return undefined;
    }
    const recipientById = new Map(
      unorderedRecipients.map((recipient) => [recipient.id, recipient]),
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
      email,
      message: deliveryMessageRecordSchema.parse(message),
      recipients: recipients.map((recipient) =>
        recipientRecordSchema.parse(recipient),
      ),
      outbox,
      replayed: false,
    };
  }

  async getDeliveryLedger(
    messageId: string,
  ): Promise<DeliveryLedgerSnapshot | undefined> {
    const stored = await this.getStoredDeliveryState(messageId);
    if (!stored) {
      return undefined;
    }
    const events = await this.listProviderEvents(messageId);
    return {
      ...structuredClone(stored.snapshot),
      events,
    };
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
        if (JSON.stringify(existing) !== JSON.stringify(attempt)) {
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
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: this.deliveryLedgerTransaction(
              stored,
              plan,
              { putAttempt: attempt },
            ),
          }),
        );
        return this.deliveryLedgerResult(
          attempt.message_id,
          false,
          plan.changed_recipient_ids,
          { attempt },
        );
      } catch (error) {
        if (!this.isTransactionConflict(error)) {
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
          existing.completed_at === new Date(input.completed_at).toISOString() &&
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
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: this.deliveryLedgerTransaction(
              stored,
              plan,
              { updateAttempt: plan.attempt },
            ),
          }),
        );
        return this.deliveryLedgerResult(
          input.message_id,
          false,
          plan.changed_recipient_ids,
          { attempt: plan.attempt },
        );
      } catch (error) {
        if (!this.isTransactionConflict(error)) {
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
      if (!isEquivalentProviderEventReplay(replay, event)) {
        throw new ConflictError(
          "Provider event identity is already used by a different normalized event.",
        );
      }
      await this.recordLatestProviderEventReceivedAt(replay.received_at);
      return this.deliveryLedgerResult(replay.message_id, true, [], {
        event: replay,
      });
    }
    for (let retry = 0; retry < DELIVERY_LEDGER_RETRIES; retry += 1) {
      const stored = await this.getStoredDeliveryState(event.message_id);
      if (!stored) {
        return undefined;
      }
      const plan = planProviderEvent(stored.snapshot, event);
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: this.deliveryLedgerTransaction(
              stored,
              plan,
              { putEvent: event },
            ),
          }),
        );
        await this.recordLatestProviderEventReceivedAt(event.received_at);
        return this.deliveryLedgerResult(
          event.message_id,
          false,
          plan.changed_recipient_ids,
          { event },
        );
      } catch (error) {
        if (!this.isTransactionConflict(error)) {
          throw error;
        }
        const existing = await this.getProviderEvent(event.id);
        if (existing) {
          if (!isEquivalentProviderEventReplay(existing, event)) {
            throw new ConflictError(
              "Provider event identity is already used by a different normalized event.",
            );
          }
          await this.recordLatestProviderEventReceivedAt(
            existing.received_at,
          );
          return this.deliveryLedgerResult(
            existing.message_id,
            true,
            [],
            { event: existing },
          );
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
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: this.deliveryLedgerTransaction(stored, plan),
          }),
        );
        return this.deliveryLedgerResult(
          messageId,
          false,
          plan.changed_recipient_ids,
        );
      } catch (error) {
        if (!this.isTransactionConflict(error)) {
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
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: providerEventKey(id),
        ConsistentRead: true,
      }),
    );
    const event = (result.Item as StoredProviderEvent | undefined)?.entity;
    return event ? providerEventRecordSchema.parse(event) : undefined;
  }

  async getLatestProviderEventReceivedAt(): Promise<string | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: providerEventMetricsKey(),
        ConsistentRead: true,
      }),
    );
    return (result.Item as StoredProviderEventMetrics | undefined)
      ?.latest_received_at;
  }

  async getOutboxItem(id: string): Promise<OutboxItemRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: outboxKey(id),
        ConsistentRead: true,
      }),
    );
    const item = (result.Item as StoredOutboxItem | undefined)?.entity;
    return item ? outboxItemRecordSchema.parse(item) : undefined;
  }

  async leaseDueOutbox(
    input: LeaseDueOutboxInput,
  ): Promise<OutboxItemRecord[]> {
    if (!/^[^\s@]{1,512}$/.test(input.owner)) {
      throw new Error("Outbox lease owner must be a privacy-safe opaque ID.");
    }
    if (
      !Number.isInteger(input.lease_seconds) ||
      input.lease_seconds <= 0
    ) {
      throw new Error("Outbox lease duration must be a positive integer.");
    }
    if (
      !Number.isInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > 1_000
    ) {
      throw new Error("Outbox lease limit must be between 1 and 1000.");
    }
    const nowIso = input.now.toISOString();
    const leaseExpiresAt = new Date(
      input.now.getTime() + input.lease_seconds * 1_000,
    ).toISOString();
    const [pending, expired] = await Promise.all([
      this.queryOutboxPartition(
        OUTBOX_DUE_PARTITION,
        `${nowIso}#\uffff`,
        input.limit,
      ),
      this.queryOutboxPartition(
        OUTBOX_LEASED_PARTITION,
        `${nowIso}#\uffff`,
        input.limit,
      ),
    ]);
    const candidates = [
      ...new Map(
        [...pending.items, ...expired.items]
          .sort(
            (left, right) =>
              left.entity.due_at.localeCompare(right.entity.due_at) ||
              left.entity.id.localeCompare(right.entity.id),
          )
          .map((item) => [item.entity.id, item]),
      ).values(),
    ];
    const leased: OutboxItemRecord[] = [];
    for (const candidate of candidates) {
      if (leased.length >= input.limit) {
        break;
      }
      try {
        const result = await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: outboxKey(candidate.entity.id),
            UpdateExpression:
              "SET entity.lease_owner = :owner, entity.lease_expires_at = :lease, entity.attempts = entity.attempts + :one, entity.updated_at = :now, GSI1PK = :leased_partition, GSI1SK = :lease_sort",
            ConditionExpression:
              "attribute_exists(PK) AND attribute_not_exists(entity.dispatched_at) AND entity.due_at <= :now AND (attribute_not_exists(entity.lease_expires_at) OR entity.lease_expires_at <= :now)",
            ExpressionAttributeValues: {
              ":owner": input.owner,
              ":lease": leaseExpiresAt,
              ":one": 1,
              ":now": nowIso,
              ":leased_partition": OUTBOX_LEASED_PARTITION,
              ":lease_sort": outboxSort(
                leaseExpiresAt,
                candidate.entity.id,
              ),
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        const item = (result.Attributes as StoredOutboxItem | undefined)
          ?.entity;
        if (item) {
          leased.push(outboxItemRecordSchema.parse(item));
        }
      } catch (error) {
        if (
          (error as { name?: string }).name !==
          "ConditionalCheckFailedException"
        ) {
          throw error;
        }
      }
    }
    return leased;
  }

  async acknowledgeOutbox(
    id: string,
    owner: string,
    now: Date,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: outboxKey(id),
                UpdateExpression:
                  "SET entity.dispatched_at = :now, entity.updated_at = :now REMOVE entity.lease_owner, entity.lease_expires_at, GSI1PK, GSI1SK",
                ConditionExpression:
                  "entity.lease_owner = :owner AND attribute_not_exists(entity.dispatched_at)",
                ExpressionAttributeValues: {
                  ":owner": owner,
                  ":now": now.toISOString(),
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: outboxMetricsKey(),
                UpdateExpression:
                  "SET updated_at = :now ADD undispatched :minus_one",
                ExpressionAttributeValues: {
                  ":now": now.toISOString(),
                  ":minus_one": -1,
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name ===
        "TransactionCanceledException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async recordOutboxFailure(
    id: string,
    owner: string,
    category: DeliveryDiagnosticCategory,
    now: Date,
  ): Promise<boolean> {
    const parsedCategory =
      deliveryDiagnosticCategorySchema.parse(category);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: outboxKey(id),
                UpdateExpression:
                  "SET entity.last_diagnostic_category = :category, entity.updated_at = :now, GSI1PK = :due_partition, GSI1SK = :due_sort REMOVE entity.lease_owner, entity.lease_expires_at",
                ConditionExpression:
                  "entity.lease_owner = :owner AND attribute_not_exists(entity.dispatched_at)",
                ExpressionAttributeValues: {
                  ":category": parsedCategory,
                  ":owner": owner,
                  ":now": now.toISOString(),
                  ":due_partition": OUTBOX_DUE_PARTITION,
                  ":due_sort": outboxSort(now.toISOString(), id),
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: outboxMetricsKey(),
                UpdateExpression:
                  "SET updated_at = :now ADD publish_failures_total :one",
                ExpressionAttributeValues: {
                  ":now": now.toISOString(),
                  ":one": 1,
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name ===
        "TransactionCanceledException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async getOutboxMetrics(now: Date): Promise<OutboxMetrics> {
    const [duePage, leasedPage, metricsResult] = await Promise.all([
      this.queryOutboxPartition(
        OUTBOX_DUE_PARTITION,
        undefined,
        OUTBOX_METRIC_QUERY_LIMIT,
      ),
      this.queryOutboxPartition(
        OUTBOX_LEASED_PARTITION,
        undefined,
        OUTBOX_METRIC_QUERY_LIMIT,
      ),
      this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: outboxMetricsKey(),
          ConsistentRead: true,
        }),
      ),
    ]);
    const nowEpochMilliseconds = now.getTime();
    const dueItems = duePage.items.filter(
      (item) => Date.parse(item.entity.due_at) <= nowEpochMilliseconds,
    );
    const stuckItems = leasedPage.items.filter(
      (item) =>
        item.entity.lease_expires_at !== undefined &&
        Date.parse(item.entity.lease_expires_at) <= nowEpochMilliseconds,
    );
    const activeLeases = leasedPage.items.length - stuckItems.length;
    const oldestDueAt = [...dueItems, ...stuckItems].reduce<
      number | undefined
    >((oldest, item) => {
      const dueAt = Date.parse(item.entity.due_at);
      return oldest === undefined ? dueAt : Math.min(oldest, dueAt);
    }, undefined);
    const metrics = metricsResult.Item as
      | StoredOutboxMetrics
      | undefined;
    return {
      due: dueItems.length + stuckItems.length,
      leased: activeLeases,
      stuck_leases: stuckItems.length,
      undispatched: metrics?.undispatched ?? 0,
      oldest_due_age_seconds:
        oldestDueAt === undefined
          ? 0
          : Math.max(
              0,
              Math.floor(
                (nowEpochMilliseconds - oldestDueAt) / 1_000,
              ),
            ),
      publish_failures_total: metrics?.publish_failures_total ?? 0,
      truncated: duePage.truncated || leasedPage.truncated,
    };
  }

  async getEmail(id: string): Promise<EmailRecord | undefined> {
    const record = await this.getEntity<EmailRecord>("EMAIL", id);
    return record ? this.hydrateEmailPayload(record) : undefined;
  }

  async claimEmailForSend(
    id: string,
    attempt: number,
    now: Date,
  ): Promise<EmailRecord | undefined> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: entityKey("EMAIL", id),
          UpdateExpression:
            "SET entity.#status = :sending, entity.last_event = :event, entity.attempts = :attempt, entity.updated_at = :updated, entity.send_lease_until = :lease REMOVE entity.#error",
          ConditionExpression:
            "entity.#status IN (:queued, :scheduled) OR (entity.#status = :sending AND entity.send_lease_until < :now)",
          ExpressionAttributeNames: {
            "#status": "status",
            "#error": "error",
          },
          ExpressionAttributeValues: {
            ":sending": "sending",
            ":queued": "queued",
            ":scheduled": "scheduled",
            ":event": "sending",
            ":attempt": attempt,
            ":updated": now.toISOString(),
            ":lease": Math.floor(now.getTime() / 1_000) + 120,
            ":now": Math.floor(now.getTime() / 1_000),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      const record = (result.Attributes as StoredEntity | undefined)?.entity as
        | EmailRecord
        | undefined;
      return record ? await this.hydrateEmailPayload(record) : undefined;
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async updateEmail(
    id: string,
    updates: Partial<EmailRecord>,
    fromStatuses?: EmailStatus[],
  ): Promise<EmailRecord | undefined> {
    const setExpressions: string[] = [];
    const removeExpressions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    Object.entries(updates).forEach(([field, value], index) => {
      const name = `#field${index}`;
      names[name] = field;
      if (value === undefined) {
        removeExpressions.push(`entity.${name}`);
      } else {
        const placeholder = `:value${index}`;
        values[placeholder] = value;
        setExpressions.push(`entity.${name} = ${placeholder}`);
      }
    });
    if (setExpressions.length === 0 && removeExpressions.length === 0) {
      return this.getEntity<EmailRecord>("EMAIL", id);
    }

    const updateExpression = [
      setExpressions.length > 0 ? `SET ${setExpressions.join(", ")}` : "",
      removeExpressions.length > 0
        ? `REMOVE ${removeExpressions.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    let conditionExpression = "attribute_exists(PK)";
    if (fromStatuses && fromStatuses.length > 0) {
      names["#currentStatus"] = "status";
      const statusValues = fromStatuses.map((status, index) => {
        const placeholder = `:fromStatus${index}`;
        values[placeholder] = status;
        return placeholder;
      });
      conditionExpression += ` AND entity.#currentStatus IN (${statusValues.join(", ")})`;
    }

    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: entityKey("EMAIL", id),
          UpdateExpression: updateExpression,
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return (result.Attributes as StoredEntity | undefined)?.entity as
        | EmailRecord
        | undefined;
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async rescheduleEmailAndOutbox(
    id: string,
    scheduledAt: string,
    now: Date,
  ): Promise<EmailRecord | undefined> {
    const outboxId = createOutboxIdentity({
      message_id: id,
      job_type: "dispatch-message",
      generation: 0,
    });
    const timestamp = now.toISOString();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: entityKey("EMAIL", id),
                UpdateExpression:
                  "SET entity.scheduled_at = :scheduled, entity.#status = :scheduled_status, entity.last_event = :event, entity.updated_at = :updated",
                ConditionExpression:
                  "entity.#status IN (:queued, :scheduled_status)",
                ExpressionAttributeNames: {
                  "#status": "status",
                },
                ExpressionAttributeValues: {
                  ":scheduled": scheduledAt,
                  ":scheduled_status": "scheduled",
                  ":queued": "queued",
                  ":event": "scheduled",
                  ":updated": timestamp,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: deliveryMessageKey(id),
                UpdateExpression:
                  "SET entity.scheduled_at = :scheduled, entity.#status = :scheduled_status, entity.updated_at = :updated",
                ConditionExpression: "attribute_exists(PK)",
                ExpressionAttributeNames: {
                  "#status": "status",
                },
                ExpressionAttributeValues: {
                  ":scheduled": scheduledAt,
                  ":scheduled_status": "scheduled",
                  ":updated": timestamp,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: outboxKey(outboxId),
                UpdateExpression:
                  "SET entity.due_at = :scheduled, entity.updated_at = :updated, GSI1PK = :due_partition, GSI1SK = :due_sort",
                ConditionExpression:
                  "attribute_not_exists(entity.dispatched_at) AND attribute_not_exists(entity.lease_owner)",
                ExpressionAttributeValues: {
                  ":scheduled": scheduledAt,
                  ":updated": timestamp,
                  ":due_partition": OUTBOX_DUE_PARTITION,
                  ":due_sort": outboxSort(scheduledAt, outboxId),
                },
              },
            },
          ],
        }),
      );
      return this.getEmail(id);
    } catch (error) {
      if (
        (error as { name?: string }).name ===
        "TransactionCanceledException"
      ) {
        const [email, outbox] = await Promise.all([
          this.getEmail(id),
          this.getOutboxItem(outboxId),
        ]);
        if (
          email &&
          ["queued", "scheduled"].includes(email.status) &&
          outbox &&
          outbox.dispatched_at === undefined &&
          outbox.lease_owner === undefined
        ) {
          throw error;
        }
        return undefined;
      }
      throw error;
    }
  }

  async listEmails(limit: number, cursor?: string): Promise<Page<EmailRecord>> {
    return this.listEntities<EmailRecord>("EMAIL", limit, cursor);
  }

  async createTemplate(record: TemplateRecord): Promise<void> {
    const alias = record.draft.alias;
    const templatePut = {
      Put: {
        TableName: this.tableName,
        Item: storedEntity("TEMPLATE", record),
        ConditionExpression: "attribute_not_exists(PK)",
      },
    };
    try {
      if (alias === undefined) {
        await this.client.send(new PutCommand(templatePut.Put));
        return;
      }
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            templatePut,
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...entityKey("TEMPLATE_ALIAS", alias),
                  template_id: record.id,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        [
          "ConditionalCheckFailedException",
          "TransactionCanceledException",
        ].includes((error as { name?: string }).name ?? "")
      ) {
        throw new ConflictError("Template alias is already in use.");
      }
      throw error;
    }
  }

  async getTemplate(identifier: string): Promise<TemplateRecord | undefined> {
    const direct = await this.getEntity<TemplateRecord>("TEMPLATE", identifier);
    if (direct) {
      return direct;
    }
    const alias = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: entityKey("TEMPLATE_ALIAS", identifier),
        ConsistentRead: true,
      }),
    );
    const templateId = (alias.Item as { template_id?: string } | undefined)
      ?.template_id;
    return templateId
      ? this.getEntity<TemplateRecord>("TEMPLATE", templateId)
      : undefined;
  }

  async getPublishedTemplate(
    identifier: string,
  ): Promise<TemplateRecord | undefined> {
    const direct = await this.getEntity<TemplateRecord>("TEMPLATE", identifier);
    if (direct) {
      return direct;
    }
    const alias = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: entityKey("TEMPLATE_PUBLISHED_ALIAS", identifier),
        ConsistentRead: true,
      }),
    );
    const templateId = (alias.Item as { template_id?: string } | undefined)
      ?.template_id;
    if (templateId) {
      return this.getEntity<TemplateRecord>("TEMPLATE", templateId);
    }

    const legacy = await this.getTemplate(identifier);
    return legacy &&
      (!legacy.published || legacy.published.alias === identifier)
      ? legacy
      : undefined;
  }

  async replaceTemplate(
    record: TemplateRecord,
    previousAlias: string | undefined,
    expectedRevision: number,
  ): Promise<boolean> {
    const nextAlias = record.draft.alias;
    const items: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
    > = [
      {
        Put: {
          TableName: this.tableName,
          Item: storedEntity("TEMPLATE", record),
          ConditionExpression:
            "attribute_exists(PK) AND entity.#revision = :expected_revision",
          ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: {
            ":expected_revision": expectedRevision,
          },
        },
      },
    ];
    if (previousAlias !== undefined && previousAlias !== nextAlias) {
      items.push({
        Delete: {
          TableName: this.tableName,
          Key: entityKey("TEMPLATE_ALIAS", previousAlias),
          ConditionExpression: "template_id = :template_id",
          ExpressionAttributeValues: { ":template_id": record.id },
        },
      });
    }
    if (nextAlias !== undefined && nextAlias !== previousAlias) {
      items.push({
        Put: {
          TableName: this.tableName,
          Item: {
            ...entityKey("TEMPLATE_ALIAS", nextAlias),
            template_id: record.id,
          },
          ConditionExpression:
            "attribute_not_exists(PK) OR template_id = :template_id",
          ExpressionAttributeValues: { ":template_id": record.id },
        },
      });
    }
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === "TransactionCanceledException"
      ) {
        throw new ConflictError(
          "Template alias is already in use or the template changed concurrently.",
        );
      }
      throw error;
    }
  }

  async publishTemplate(
    record: TemplateRecord,
    publication: TemplatePublicationRecord,
    previousPublishedAlias: string | undefined,
    expectedRevision: number,
    historyLimit: number,
  ): Promise<boolean> {
    const existing = await this.listTemplateVersionKeys(record.id);
    const prune = existing
      .sort((left, right) => right.GSI1SK.localeCompare(left.GSI1SK))
      .slice(Math.max(0, historyLimit - 1));
    const nextPublishedAlias = record.published?.alias;
    const items: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
    > = [
      {
        Put: {
          TableName: this.tableName,
          Item: storedEntity("TEMPLATE", record),
          ConditionExpression:
            "attribute_exists(PK) AND entity.#revision = :expected_revision",
          ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: {
            ":expected_revision": expectedRevision,
          },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: storedTemplatePublication(publication),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      ...prune.map((item) => ({
        Delete: {
          TableName: this.tableName,
          Key: { PK: item.PK, SK: item.SK },
        },
      })),
    ];
    if (
      previousPublishedAlias !== undefined &&
      previousPublishedAlias !== nextPublishedAlias
    ) {
      items.push({
        Delete: {
          TableName: this.tableName,
          Key: entityKey(
            "TEMPLATE_PUBLISHED_ALIAS",
            previousPublishedAlias,
          ),
          ConditionExpression:
            "attribute_not_exists(PK) OR template_id = :template_id",
          ExpressionAttributeValues: { ":template_id": record.id },
        },
      });
    }
    if (nextPublishedAlias !== undefined) {
      items.push({
        Put: {
          TableName: this.tableName,
          Item: {
            ...entityKey(
              "TEMPLATE_PUBLISHED_ALIAS",
              nextPublishedAlias,
            ),
            template_id: record.id,
          },
          ConditionExpression:
            "attribute_not_exists(PK) OR template_id = :template_id",
          ExpressionAttributeValues: { ":template_id": record.id },
        },
      });
    }
    if (items.length > 100) {
      throw new ConflictError(
        "Template history exceeds the configured retention limit.",
      );
    }
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === "TransactionCanceledException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async getTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<TemplatePublicationRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: templateVersionKey(templateId, versionId),
        ConsistentRead: true,
      }),
    );
    return (result.Item as StoredTemplatePublication | undefined)?.entity;
  }

  async listTemplateVersions(
    templateId: string,
    limit: number,
    cursor: TemplatePublicationRecord | undefined,
    nowEpochSeconds: number,
  ): Promise<Page<TemplatePublicationRecord>> {
    const data: TemplatePublicationRecord[] = [];
    let exclusiveStartKey = cursor
      ? storedTemplatePublication(cursor)
      : undefined;
    while (data.length <= limit) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :partition",
          ExpressionAttributeValues: {
            ":partition": `TEMPLATE_VERSIONS#${templateId}`,
          },
          ...(exclusiveStartKey
            ? {
                ExclusiveStartKey: {
                  PK: exclusiveStartKey.PK,
                  SK: exclusiveStartKey.SK,
                  GSI1PK: exclusiveStartKey.GSI1PK,
                  GSI1SK: exclusiveStartKey.GSI1SK,
                },
              }
            : {}),
          ScanIndexForward: false,
          Limit: Math.min(100, limit + 1),
        }),
      );
      for (const item of result.Items ?? []) {
        const publication = (item as StoredTemplatePublication).entity;
        if (
          Math.floor(Date.parse(publication.expires_at) / 1_000) >
          nowEpochSeconds
        ) {
          data.push(publication);
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey
        ? (result.LastEvaluatedKey as StoredTemplatePublication)
        : undefined;
      if (!exclusiveStartKey || data.length > limit) {
        break;
      }
    }
    const page = data.slice(0, limit);
    return data.length > limit && page.length > 0
      ? {
          data: page,
          has_more: true,
          next_cursor: page.at(-1)?.id,
        }
      : { data: page, has_more: false };
  }

  async deleteTemplate(
    record: TemplateRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const versions = await this.listTemplateVersionKeys(record.id);
    const items: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
    > = [
      {
        Delete: {
          TableName: this.tableName,
          Key: entityKey("TEMPLATE", record.id),
          ConditionExpression:
            "attribute_exists(PK) AND entity.#revision = :expected_revision",
          ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: {
            ":expected_revision": expectedRevision,
          },
        },
      },
    ];
    if (record.draft.alias !== undefined) {
      items.push({
        Delete: {
          TableName: this.tableName,
          Key: entityKey("TEMPLATE_ALIAS", record.draft.alias),
          ConditionExpression: "template_id = :template_id",
          ExpressionAttributeValues: { ":template_id": record.id },
        },
      });
    }
    if (record.published?.alias !== undefined) {
      items.push({
        Delete: {
          TableName: this.tableName,
          Key: entityKey(
            "TEMPLATE_PUBLISHED_ALIAS",
            record.published.alias,
          ),
          ConditionExpression:
            "attribute_not_exists(PK) OR template_id = :template_id",
          ExpressionAttributeValues: { ":template_id": record.id },
        },
      });
    }
    for (const version of versions) {
      items.push({
        Delete: {
          TableName: this.tableName,
          Key: { PK: version.PK, SK: version.SK },
        },
      });
    }
    if (items.length > 100) {
      throw new ConflictError(
        "Template history exceeds the configured deletion limit.",
      );
    }
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === "TransactionCanceledException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async listTemplates(
    limit: number,
    cursor?: string,
    direction: "after" | "before" = "after",
  ): Promise<Page<TemplateRecord>> {
    const anchor = cursor
      ? await this.getEntity<TemplateRecord>("TEMPLATE", cursor)
      : undefined;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression:
          direction === "before" && anchor
            ? "GSI1PK = :partition AND GSI1SK > :anchor"
            : "GSI1PK = :partition",
        ExpressionAttributeValues: {
          ":partition": "TEMPLATES",
          ...(direction === "before" && anchor
            ? { ":anchor": `${anchor.created_at}#${anchor.id}` }
            : {}),
        },
        ...(direction === "after" && anchor
          ? {
              ExclusiveStartKey: {
                ...entityKey("TEMPLATE", anchor.id),
                GSI1PK: "TEMPLATES",
                GSI1SK: `${anchor.created_at}#${anchor.id}`,
              },
            }
          : {}),
        ScanIndexForward: direction === "before",
        Limit: limit,
      }),
    );
    const queried = (result.Items ?? []).map(
      (item) => (item as StoredEntity).entity as TemplateRecord,
    );
    const data = direction === "before" ? queried.reverse() : queried;
    return result.LastEvaluatedKey && data.length > 0
      ? {
          data,
          has_more: true,
          next_cursor: direction === "before" ? data[0]?.id : data.at(-1)?.id,
        }
      : { data, has_more: false };
  }

  async putAttachmentUpload(record: AttachmentUploadRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...entityKey("ATTACHMENT", record.id),
          entity: record,
          ttl: Math.floor(new Date(record.expires_at).getTime() / 1_000),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async getAttachmentUpload(
    id: string,
  ): Promise<AttachmentUploadRecord | undefined> {
    return this.getEntity<AttachmentUploadRecord>("ATTACHMENT", id);
  }

  async claimReceivedEmail(
    id: string,
    now: number,
    leaseUntil: number,
    expiresAt: number,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: entityKey("RECEIVED_CLAIM", id),
          UpdateExpression: "SET lease_until = :lease, #ttl = :ttl",
          ConditionExpression: "attribute_not_exists(PK) OR lease_until < :now",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":lease": leaseUntil,
            ":now": now,
            ":ttl": expiresAt,
          },
        }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async releaseReceivedEmailClaim(
    id: string,
    leaseUntil: number,
  ): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: entityKey("RECEIVED_CLAIM", id),
          ConditionExpression: "lease_until = :lease",
          ExpressionAttributeValues: {
            ":lease": leaseUntil,
          },
        }),
      );
    } catch (error) {
      if (
        (error as { name?: string }).name !== "ConditionalCheckFailedException"
      ) {
        throw error;
      }
    }
  }

  async createReceivedEmail(record: ReceivedEmailRecord): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...storedEntity("RECEIVED", record),
            ttl: Math.floor(new Date(record.expires_at).getTime() / 1_000),
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async getReceivedEmail(id: string): Promise<ReceivedEmailRecord | undefined> {
    return this.getEntity<ReceivedEmailRecord>("RECEIVED", id);
  }

  async updateReceivedEmail(
    id: string,
    updates: Partial<ReceivedEmailRecord>,
  ): Promise<ReceivedEmailRecord | undefined> {
    return this.updateEntity<ReceivedEmailRecord>("RECEIVED", id, updates);
  }

  async listReceivedEmails(
    limit: number,
    cursor?: string,
  ): Promise<Page<ReceivedEmailRecord>> {
    return this.listEntities<ReceivedEmailRecord>(
      "RECEIVED",
      limit,
      cursor,
      true,
    );
  }

  async createDomain(record: DomainRecord): Promise<void> {
    await this.putEntity("DOMAIN", record);
  }

  async getDomain(id: string): Promise<DomainRecord | undefined> {
    return this.getEntity<DomainRecord>("DOMAIN", id);
  }

  async updateDomain(
    id: string,
    updates: Partial<DomainRecord>,
  ): Promise<DomainRecord | undefined> {
    return this.updateEntity<DomainRecord>("DOMAIN", id, updates);
  }

  async deleteDomain(id: string): Promise<boolean> {
    return this.deleteEntity("DOMAIN", id);
  }

  async listDomains(
    limit: number,
    cursor?: string,
  ): Promise<Page<DomainRecord>> {
    return this.listEntities<DomainRecord>("DOMAIN", limit, cursor);
  }

  async createWebhook(record: WebhookEndpoint): Promise<void> {
    await this.putEntity("WEBHOOK", record);
  }

  async getWebhook(id: string): Promise<WebhookEndpoint | undefined> {
    return this.getEntity<WebhookEndpoint>("WEBHOOK", id);
  }

  async updateWebhook(
    id: string,
    updates: Partial<Pick<WebhookEndpoint, "endpoint" | "events" | "status">>,
  ): Promise<WebhookEndpoint | undefined> {
    const entries = Object.entries(updates);
    if (entries.length === 0) {
      return this.getWebhook(id);
    }
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const setExpressions = entries.map(([field, value], index) => {
      const name = `#field${index}`;
      const placeholder = `:value${index}`;
      names[name] = field;
      values[placeholder] = value;
      return `entity.${name} = ${placeholder}`;
    });
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: entityKey("WEBHOOK", id),
          UpdateExpression: `SET ${setExpressions.join(", ")}`,
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return (result.Attributes as StoredEntity | undefined)?.entity as
        | WebhookEndpoint
        | undefined;
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async deleteWebhook(id: string): Promise<boolean> {
    return this.deleteEntity("WEBHOOK", id);
  }

  async listWebhooks(
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookEndpoint>> {
    return this.listEntities<WebhookEndpoint>("WEBHOOK", limit, cursor);
  }

  async createWebhookDelivery(record: WebhookDeliveryRecord): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...entityKey("WEBHOOK_DELIVERY", record.id),
            GSI1PK: `WEBHOOK_DELIVERIES#${record.webhook_id}`,
            GSI1SK: `${record.created_at}#${record.id}`,
            entity: record,
            ttl: Math.floor(Date.parse(record.expires_at) / 1_000),
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async getWebhookDelivery(
    id: string,
  ): Promise<WebhookDeliveryRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: entityKey("WEBHOOK_DELIVERY", id),
        ConsistentRead: true,
      }),
    );
    const record = (result.Item as StoredEntity | undefined)?.entity as
      | WebhookDeliveryRecord
      | undefined;
    if (!record || Date.parse(record.expires_at) <= Date.now()) {
      return undefined;
    }
    return record;
  }

  async updateWebhookDelivery(
    id: string,
    updates: Partial<
      Pick<
        WebhookDeliveryRecord,
        | "status"
        | "attempts"
        | "response_status"
        | "last_error"
        | "last_attempt_at"
        | "updated_at"
      >
    >,
  ): Promise<WebhookDeliveryRecord | undefined> {
    const setExpressions: string[] = [];
    const removeExpressions: string[] = [];
    const names: Record<string, string> = {
      "#ttl": "ttl",
    };
    const values: Record<string, unknown> = {
      ":now": Math.floor(Date.now() / 1_000),
    };
    Object.entries(updates).forEach(([field, value], index) => {
      const name = `#field${index}`;
      names[name] = field;
      if (value === undefined) {
        removeExpressions.push(`entity.${name}`);
      } else {
        const placeholder = `:value${index}`;
        values[placeholder] = value;
        setExpressions.push(`entity.${name} = ${placeholder}`);
      }
    });
    if (setExpressions.length === 0 && removeExpressions.length === 0) {
      return this.getWebhookDelivery(id);
    }
    const updateExpression = [
      setExpressions.length > 0 ? `SET ${setExpressions.join(", ")}` : "",
      removeExpressions.length > 0
        ? `REMOVE ${removeExpressions.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: entityKey("WEBHOOK_DELIVERY", id),
          UpdateExpression: updateExpression,
          ConditionExpression: "attribute_exists(PK) AND #ttl > :now",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return (result.Attributes as StoredEntity | undefined)?.entity as
        | WebhookDeliveryRecord
        | undefined;
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async listWebhookDeliveries(
    webhookId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookDeliveryRecord>> {
    const anchor = cursor ? await this.getWebhookDelivery(cursor) : undefined;
    if (cursor && (!anchor || anchor.webhook_id !== webhookId)) {
      throw new ValidationError("The pagination cursor is invalid.");
    }
    let exclusiveStartKey: Record<string, unknown> | undefined = anchor
      ? {
          ...entityKey("WEBHOOK_DELIVERY", anchor.id),
          GSI1PK: `WEBHOOK_DELIVERIES#${anchor.webhook_id}`,
          GSI1SK: `${anchor.created_at}#${anchor.id}`,
        }
      : undefined;
    const data: WebhookDeliveryRecord[] = [];
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :partition",
          FilterExpression: "#ttl > :now",
          ExpressionAttributeNames: {
            "#ttl": "ttl",
          },
          ExpressionAttributeValues: {
            ":partition": `WEBHOOK_DELIVERIES#${webhookId}`,
            ":now": Math.floor(Date.now() / 1_000),
          },
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
          ScanIndexForward: false,
          Limit: Math.min(100, limit + 1 - data.length),
        }),
      );
      data.push(
        ...(result.Items ?? []).map(
          (item) => (item as StoredEntity).entity as WebhookDeliveryRecord,
        ),
      );
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey && data.length <= limit);
    const page = data.slice(0, limit);
    return data.length > limit && page.length > 0
      ? {
          data: page,
          has_more: true,
          next_cursor: page.at(-1)?.id,
        }
      : { data: page, has_more: false };
  }

  async createApiKey(record: ApiKeyRecord): Promise<void> {
    await this.putEntity("APIKEY", record);
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    return this.getEntity<ApiKeyRecord>("APIKEY", id);
  }

  async updateApiKey(
    id: string,
    updates: Partial<ApiKeyRecord>,
  ): Promise<ApiKeyRecord | undefined> {
    return this.updateEntity<ApiKeyRecord>("APIKEY", id, updates);
  }

  async listApiKeys(
    limit: number,
    cursor?: string,
  ): Promise<Page<ApiKeyRecord>> {
    return this.listEntities<ApiKeyRecord>("APIKEY", limit, cursor);
  }

  async putSuppression(record: SuppressionRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: storedEntity("SUPPRESSION", record),
      }),
    );
  }

  async getSuppression(
    emailHash: string,
  ): Promise<SuppressionRecord | undefined> {
    return this.getEntity<SuppressionRecord>("SUPPRESSION", emailHash);
  }

  async deleteSuppression(emailHash: string): Promise<boolean> {
    return this.deleteEntity("SUPPRESSION", emailHash);
  }

  async listSuppressions(
    limit: number,
    cursor?: string,
  ): Promise<Page<SuppressionRecord>> {
    return this.listEntities<SuppressionRecord>("SUPPRESSION", limit, cursor);
  }

  private async getStoredDeliveryState(
    messageId: string,
  ): Promise<StoredDeliveryState | undefined> {
    const items: Array<Record<string, unknown>> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :partition",
          ExpressionAttributeValues: {
            ":partition": `EMAIL#${messageId}`,
          },
          ConsistentRead: true,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    const emailItem = items.find(
      (item) => item.SK === `EMAIL#${messageId}`,
    ) as StoredEntity | undefined;
    const messageItem = items.find(
      (item) => item.SK === `DELIVERY_MESSAGE#${messageId}`,
    ) as StoredDeliveryRecord<DeliveryMessageRecord> | undefined;
    if (!emailItem || !messageItem) {
      return undefined;
    }
    const message = deliveryMessageRecordSchema.parse(messageItem.entity);
    const recipientItems = new Map<string, StoredDeliveryRecord<RecipientRecord>>();
    const attemptItems = new Map<
      string,
      StoredDeliveryRecord<DeliveryAttemptRecord>
    >();
    for (const item of items) {
      if (
        typeof item.SK === "string" &&
        item.SK.startsWith("RECIPIENT#")
      ) {
        const stored = item as unknown as StoredDeliveryRecord<RecipientRecord>;
        const recipient = recipientRecordSchema.parse(stored.entity);
        recipientItems.set(recipient.id, { ...stored, entity: recipient });
      } else if (
        typeof item.SK === "string" &&
        item.SK.startsWith("ATTEMPT#")
      ) {
        const stored =
          item as unknown as StoredDeliveryRecord<DeliveryAttemptRecord>;
        const attempt = deliveryAttemptRecordSchema.parse(stored.entity);
        attemptItems.set(attempt.id, { ...stored, entity: attempt });
      }
    }
    const recipients = message.recipient_ids.map((id) =>
      recipientItems.get(id)?.entity,
    );
    if (recipients.some((recipient) => recipient === undefined)) {
      return undefined;
    }
    const attempts = [...attemptItems.values()]
      .map((item) => item.entity)
      .sort(
        (left, right) =>
          left.sequence - right.sequence || left.id.localeCompare(right.id),
      );
    return {
      emailItem,
      messageItem: { ...messageItem, entity: message },
      recipientItems,
      attemptItems,
      snapshot: {
        email: structuredClone(emailItem.entity as EmailRecord),
        message,
        recipients: recipients as RecipientRecord[],
        attempts,
      },
    };
  }

  private async listProviderEvents(
    messageId: string,
  ): Promise<ProviderEventRecord[]> {
    const events: ProviderEventRecord[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :partition",
          ExpressionAttributeValues: {
            ":partition": `DELIVERY_EVENTS#${messageId}`,
          },
          ScanIndexForward: true,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      for (const item of result.Items ?? []) {
        const event = (item as StoredProviderEvent).entity;
        events.push(providerEventRecordSchema.parse(event));
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return events;
  }

  private deliveryLedgerTransaction(
    stored: StoredDeliveryState,
    plan: DeliveryLedgerPlan,
    addition: {
      putAttempt?: DeliveryAttemptRecord | undefined;
      updateAttempt?: DeliveryAttemptRecord | undefined;
      putEvent?: ProviderEventRecord | undefined;
    } = {},
  ): NonNullable<TransactWriteCommandInput["TransactItems"]> {
    const update = (
      key: { PK: string; SK: string },
      expected: unknown,
      next: unknown,
    ) => ({
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression: "SET entity = :next",
        ConditionExpression: "entity = :expected",
        ExpressionAttributeValues: {
          ":expected": expected,
          ":next": next,
        },
      },
    });
    const condition = (
      key: { PK: string; SK: string },
      expected: unknown,
    ) => ({
      ConditionCheck: {
        TableName: this.tableName,
        Key: key,
        ConditionExpression: "entity = :expected",
        ExpressionAttributeValues: {
          ":expected": expected,
        },
      },
    });
    const changedRecipientIds = new Set(plan.changed_recipient_ids);
    const recipientById = new Map(
      plan.recipients.map((recipient) => [recipient.id, recipient]),
    );
    const items: NonNullable<
      TransactWriteCommandInput["TransactItems"]
    > = [
      update(
        entityKey("EMAIL", plan.email.id),
        stored.snapshot.email,
        plan.email,
      ),
      update(
        deliveryMessageKey(plan.message.id),
        stored.snapshot.message,
        plan.message,
      ),
      ...stored.snapshot.message.recipient_ids.map((id) => {
        const current = stored.recipientItems.get(id);
        const next = recipientById.get(id);
        if (!current || !next) {
          throw new Error("Delivery recipient disappeared during mutation.");
        }
        return changedRecipientIds.has(id)
          ? update(
              recipientKey(plan.message.id, id),
              current.entity,
              next,
            )
          : condition(
              recipientKey(plan.message.id, id),
              current.entity,
            );
      }),
    ];

    if (addition.putAttempt) {
      items.push({
        Put: {
          TableName: this.tableName,
          Item: {
            ...attemptKey(
              addition.putAttempt.message_id,
              addition.putAttempt.sequence,
            ),
            entity: addition.putAttempt,
          } satisfies StoredDeliveryRecord<DeliveryAttemptRecord>,
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    }
    if (addition.updateAttempt) {
      const current = stored.attemptItems.get(addition.updateAttempt.id);
      if (!current) {
        throw new Error("Delivery attempt disappeared during mutation.");
      }
      items.push(
        update(
          attemptKey(
            addition.updateAttempt.message_id,
            addition.updateAttempt.sequence,
          ),
          current.entity,
          addition.updateAttempt,
        ),
      );
    }
    if (addition.putEvent) {
      const attempt = stored.attemptItems.get(
        addition.putEvent.attempt_id ?? "",
      );
      if (!attempt) {
        throw new Error("Provider event attempt disappeared during mutation.");
      }
      items.push(
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: attemptKey(
              attempt.entity.message_id,
              attempt.entity.sequence,
            ),
            ConditionExpression: "entity = :expected",
            ExpressionAttributeValues: {
              ":expected": attempt.entity,
            },
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: storedProviderEvent(addition.putEvent),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      );
    }
    if (items.length > 100) {
      throw new Error(
        "Delivery ledger transaction exceeds the DynamoDB action limit.",
      );
    }
    return items;
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
    if (
      addition.event &&
      !snapshot.events.some((event) => event.id === addition.event?.id)
    ) {
      snapshot.events.push(structuredClone(addition.event));
      snapshot.events.sort(
        (left, right) =>
          left.received_at.localeCompare(right.received_at) ||
          left.id.localeCompare(right.id),
      );
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

  private isTransactionConflict(error: unknown): boolean {
    return [
      "TransactionCanceledException",
      "TransactionConflictException",
    ].includes((error as { name?: string }).name ?? "");
  }

  private async recordLatestProviderEventReceivedAt(
    receivedAt: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: providerEventMetricsKey(),
          UpdateExpression: "SET latest_received_at = :received_at",
          ConditionExpression:
            "attribute_not_exists(latest_received_at) OR latest_received_at < :received_at",
          ExpressionAttributeValues: {
            ":received_at": receivedAt,
          },
        }),
      );
    } catch (error) {
      if (
        (error as { name?: string }).name !==
        "ConditionalCheckFailedException"
      ) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "Provider event diagnostics update failed",
            error_type: safeErrorCategory(error),
          }),
        );
      }
    }
  }

  private async putEntity(
    kind: "DOMAIN" | "WEBHOOK" | "APIKEY",
    record: DomainRecord | WebhookEndpoint | ApiKeyRecord,
  ) {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: storedEntity(kind, record),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  private async getEntity<T extends Entity>(
    kind: EntityKind,
    id: string,
  ): Promise<T | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: entityKey(kind, id),
        ConsistentRead: true,
      }),
    );
    return (result.Item as StoredEntity | undefined)?.entity as T | undefined;
  }

  private async updateEntity<T extends Entity>(
    kind: "DOMAIN" | "APIKEY" | "RECEIVED",
    id: string,
    updates: Partial<T>,
  ): Promise<T | undefined> {
    const current = await this.getEntity<T>(kind, id);
    if (!current) {
      return undefined;
    }
    const updated = { ...current, ...updates };
    const item = storedEntity(kind, updated);
    if (kind === "RECEIVED") {
      item.ttl = Math.floor(
        new Date((updated as ReceivedEmailRecord).expires_at).getTime() / 1_000,
      );
    }
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );
    return updated;
  }

  private async deleteEntity(
    kind: "DOMAIN" | "WEBHOOK" | "SUPPRESSION",
    id: string,
  ): Promise<boolean> {
    const result = await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: entityKey(kind, id),
        ReturnValues: "ALL_OLD",
      }),
    );
    return result.Attributes !== undefined;
  }

  private async listTemplateVersionKeys(templateId: string): Promise<
    Array<Pick<StoredTemplatePublication, "PK" | "SK" | "GSI1SK">>
  > {
    const versions: Array<
      Pick<StoredTemplatePublication, "PK" | "SK" | "GSI1SK">
    > = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :partition",
          ExpressionAttributeValues: {
            ":partition": `TEMPLATE_VERSION#${templateId}`,
          },
          ProjectionExpression: "PK, SK, GSI1SK",
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      for (const item of result.Items ?? []) {
        if (
          typeof item.PK === "string" &&
          typeof item.SK === "string" &&
          typeof item.GSI1SK === "string"
        ) {
          versions.push({
            PK: item.PK,
            SK: item.SK,
            GSI1SK: item.GSI1SK,
          });
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return versions;
  }

  private async listEntities<T extends Entity>(
    kind: IndexedEntityKind,
    limit: number,
    cursor?: string,
    onlyUnexpired = false,
  ): Promise<Page<T>> {
    const anchor = cursor ? await this.getEntity<T>(kind, cursor) : undefined;
    if (
      cursor &&
      (!anchor ||
        (onlyUnexpired &&
          "expires_at" in anchor &&
          Date.parse(String(anchor.expires_at)) <= Date.now()))
    ) {
      throw new ValidationError("The pagination cursor is invalid.");
    }
    let exclusiveStartKey: Record<string, unknown> | undefined = anchor
      ? {
          ...entityKey(kind, anchor.id),
          GSI1PK: INDEX_PARTITION[kind],
          GSI1SK: `${anchor.created_at}#${anchor.id}`,
        }
      : undefined;
    const data: T[] = [];
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :partition",
          ...(onlyUnexpired
            ? {
                FilterExpression: "#ttl > :now",
                ExpressionAttributeNames: { "#ttl": "ttl" },
              }
            : {}),
          ExpressionAttributeValues: {
            ":partition": INDEX_PARTITION[kind],
            ...(onlyUnexpired
              ? { ":now": Math.floor(Date.now() / 1_000) }
              : {}),
          },
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
          ScanIndexForward: false,
          Limit: Math.min(100, limit + 1 - data.length),
        }),
      );
      data.push(
        ...(result.Items ?? []).map(
          (item) => (item as StoredEntity).entity as T,
        ),
      );
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey && data.length <= limit);
    const page = data.slice(0, limit);
    return data.length > limit && page.length > 0
      ? {
          data: page,
          has_more: true,
          next_cursor: page.at(-1)?.id,
        }
      : { data: page, has_more: false };
  }

  private async queryOutboxPartition(
    partition: typeof OUTBOX_DUE_PARTITION | typeof OUTBOX_LEASED_PARTITION,
    upperSortKey: string | undefined,
    limit: number,
  ): Promise<{ items: StoredOutboxItem[]; truncated: boolean }> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: upperSortKey
          ? "GSI1PK = :partition AND GSI1SK <= :upper"
          : "GSI1PK = :partition",
        ExpressionAttributeValues: {
          ":partition": partition,
          ...(upperSortKey ? { ":upper": upperSortKey } : {}),
        },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return {
      items: (result.Items ?? []) as StoredOutboxItem[],
      truncated: result.LastEvaluatedKey !== undefined,
    };
  }

  private async externalizeEmailPayload(
    record: EmailRecord,
  ): Promise<EmailRecord> {
    if (!this.payloadBucket) {
      return record;
    }
    const key = record.payload_ref ?? `emails/${record.id}/payload.json`;
    const payload = {
      html: record.html,
      text: record.text,
      attachments: record.attachments,
    };
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.payloadBucket,
        Key: key,
        Body: JSON.stringify(payload),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      }),
    );
    const metadata = { ...record, payload_ref: key };
    delete metadata.html;
    delete metadata.text;
    delete metadata.attachments;
    return metadata;
  }

  private async hydrateEmailPayload(record: EmailRecord): Promise<EmailRecord> {
    if (!this.payloadBucket || !record.payload_ref) {
      return record;
    }
    let result;
    try {
      result = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.payloadBucket,
          Key: record.payload_ref,
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") {
        return record;
      }
      throw error;
    }
    const raw = await result.Body?.transformToString();
    if (!raw) {
      throw new Error(`Email payload ${record.payload_ref} is empty.`);
    }
    const payload = JSON.parse(raw) as Pick<
      EmailRecord,
      "html" | "text" | "attachments"
    >;
    return { ...record, ...payload };
  }
}
