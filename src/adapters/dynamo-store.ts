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
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConflictError } from "../core/errors.js";
import type {
  CreateEmailResult,
  DomainRecord,
  EmailRecord,
  IdempotencyClaim,
  Page,
  WebhookEndpoint,
} from "../core/types.js";
import type { Store } from "../ports/store.js";

type Entity = EmailRecord | DomainRecord | WebhookEndpoint;

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

function entityKey(kind: "EMAIL" | "DOMAIN" | "WEBHOOK", id: string) {
  return { PK: `${kind}#${id}`, SK: `${kind}#${id}` };
}

function storedEntity(
  kind: "EMAIL" | "DOMAIN" | "WEBHOOK",
  record: Entity,
): StoredEntity {
  const key = entityKey(kind, record.id);
  return {
    ...key,
    GSI1PK: `${kind}S`,
    GSI1SK: `${record.created_at}#${record.id}`,
    entity: record,
  };
}

function encodeCursor(value: Record<string, unknown> | undefined) {
  return value
    ? Buffer.from(JSON.stringify(value)).toString("base64url")
    : undefined;
}

function decodeCursor(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  return JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

export class DynamoStore implements Store {
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
      if ((error as { name?: string }).name !== "TransactionCanceledException") {
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
      const record = (result.Attributes as StoredEntity | undefined)
        ?.entity as EmailRecord | undefined;
      return record ? await this.hydrateEmailPayload(record) : undefined;
    } catch (error) {
      if (
        (error as { name?: string }).name ===
        "ConditionalCheckFailedException"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async updateEmail(
    id: string,
    updates: Partial<EmailRecord>,
  ): Promise<EmailRecord | undefined> {
    const current = await this.getEntity<EmailRecord>("EMAIL", id);
    if (!current) {
      return undefined;
    }
    const updated = { ...current, ...updates };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: storedEntity("EMAIL", updated),
      }),
    );
    return updated;
  }

  async listEmails(
    limit: number,
    cursor?: string,
  ): Promise<Page<EmailRecord>> {
    return this.listEntities<EmailRecord>("EMAILS", limit, cursor);
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
    return this.listEntities<DomainRecord>("DOMAINS", limit, cursor);
  }

  async createWebhook(record: WebhookEndpoint): Promise<void> {
    await this.putEntity("WEBHOOK", record);
  }

  async getWebhook(id: string): Promise<WebhookEndpoint | undefined> {
    return this.getEntity<WebhookEndpoint>("WEBHOOK", id);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    return this.deleteEntity("WEBHOOK", id);
  }

  async listWebhooks(
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookEndpoint>> {
    return this.listEntities<WebhookEndpoint>("WEBHOOKS", limit, cursor);
  }

  private async putEntity(
    kind: "DOMAIN" | "WEBHOOK",
    record: DomainRecord | WebhookEndpoint,
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
    kind: "EMAIL" | "DOMAIN" | "WEBHOOK",
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
    kind: "EMAIL" | "DOMAIN",
    id: string,
    updates: Partial<T>,
  ): Promise<T | undefined> {
    const current = await this.getEntity<T>(kind, id);
    if (!current) {
      return undefined;
    }
    const updated = { ...current, ...updates };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: storedEntity(kind, updated),
      }),
    );
    return updated;
  }

  private async deleteEntity(
    kind: "DOMAIN" | "WEBHOOK",
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

  private async listEntities<T extends Entity>(
    indexPartition: "EMAILS" | "DOMAINS" | "WEBHOOKS",
    limit: number,
    cursor?: string,
  ): Promise<Page<T>> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :partition",
        ExpressionAttributeValues: { ":partition": indexPartition },
        ExclusiveStartKey: decodeCursor(cursor),
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const data = (result.Items ?? []).map(
      (item) => (item as StoredEntity).entity as T,
    );
    const nextCursor = encodeCursor(
      result.LastEvaluatedKey as Record<string, unknown> | undefined,
    );
    return nextCursor
      ? { data, has_more: true, next_cursor: nextCursor }
      : { data, has_more: false };
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
