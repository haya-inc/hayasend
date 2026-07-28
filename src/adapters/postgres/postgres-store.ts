import type { PoolClient, QueryResultRow } from "pg";
import { ConflictError, ValidationError } from "../../core/errors.js";
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
} from "../../core/types.js";
import type { Store } from "../../ports/store.js";
import { PostgresDeliveryStore } from "./postgres-delivery-store.js";

type AppEntityKind =
  | "api_key"
  | "attachment_upload"
  | "domain"
  | "received_email"
  | "suppression"
  | "template"
  | "template_publication"
  | "webhook"
  | "webhook_delivery";

interface EntityRow extends QueryResultRow {
  id: string;
  entity: unknown;
  created_at: Date;
}

interface EmailRow extends QueryResultRow {
  entity: unknown;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  email_id: string;
  expires_at: string;
}

interface RescheduleRow extends QueryResultRow {
  email_entity: unknown;
  message_entity: unknown;
  outbox_entity: unknown;
  outbox_id: string;
  dispatched_at: Date | null;
  lease_owner: string | null;
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

function resultPage<T extends { id: string }>(
  rows: EntityRow[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = rows
    .slice(0, limit)
    .map((row) => parseEntity<T>(row.entity));
  return hasMore && data.length > 0
    ? { data, has_more: true, next_cursor: data.at(-1)?.id }
    : { data, has_more: false };
}

export class PostgresStore extends PostgresDeliveryStore implements Store {
  async createEmail(
    record: EmailRecord,
    idempotency?: IdempotencyClaim,
  ): Promise<CreateEmailResult> {
    return this.withTransaction(async (client) => {
      if (idempotency) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [idempotency.key_hash],
        );
        await client.query(
          "DELETE FROM idempotency_claims WHERE key_hash = $1 AND expires_at <= $2",
          [idempotency.key_hash, Math.floor(Date.now() / 1_000)],
        );
        const existing = await client.query<IdempotencyRow>(
          "SELECT request_hash, email_id, expires_at::text FROM idempotency_claims WHERE key_hash = $1",
          [idempotency.key_hash],
        );
        const claim = existing.rows[0];
        if (claim) {
          if (claim.request_hash !== idempotency.request_hash) {
            throw new ConflictError(
              "The Idempotency-Key has already been used with a different request.",
            );
          }
          const replay = await client.query<EmailRow>(
            "SELECT entity FROM emails WHERE id = $1",
            [claim.email_id],
          );
          const replayRow = replay.rows[0];
          if (!replayRow) {
            throw new ConflictError(
              "The idempotent request exists but its email record is unavailable.",
            );
          }
          return {
            record: parseEntity<EmailRecord>(replayRow.entity),
            replayed: true,
          };
        }
      }

      try {
        await client.query(
          "INSERT INTO emails(id, entity, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $4)",
          [
            record.id,
            JSON.stringify(record),
            record.created_at,
            record.updated_at,
          ],
        );
        if (idempotency) {
          await client.query(
            "INSERT INTO idempotency_claims(key_hash, request_hash, email_id, expires_at) VALUES ($1, $2, $3, $4)",
            [
              idempotency.key_hash,
              idempotency.request_hash,
              record.id,
              idempotency.expires_at,
            ],
          );
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError("Email identity is already in use.");
        }
        throw error;
      }
      return { record: structuredClone(record), replayed: false };
    });
  }

  async getEmail(id: string): Promise<EmailRecord | undefined> {
    const result = await this.pool.query<EmailRow>(
      "SELECT entity FROM emails WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row ? parseEntity<EmailRecord>(row.entity) : undefined;
  }

  async claimEmailForSend(
    id: string,
    attempt: number,
    now: Date,
  ): Promise<EmailRecord | undefined> {
    return this.withTransaction(async (client) => {
      const record = await this.lockEmail(client, id);
      if (!record) {
        return undefined;
      }
      const leaseExpired =
        record.status === "sending" &&
        record.send_lease_until !== undefined &&
        record.send_lease_until < Math.floor(now.getTime() / 1_000);
      if (!["queued", "scheduled"].includes(record.status) && !leaseExpired) {
        return undefined;
      }
      const updated: EmailRecord = {
        ...record,
        status: "sending",
        last_event: "sending",
        attempts: Math.max(record.attempts + 1, attempt),
        updated_at: now.toISOString(),
        send_lease_until: Math.floor(now.getTime() / 1_000) + 120,
        error: undefined,
      };
      await this.writeEmail(client, updated);
      return updated;
    });
  }

  async updateEmail(
    id: string,
    updates: Partial<EmailRecord>,
    fromStatuses?: EmailStatus[],
  ): Promise<EmailRecord | undefined> {
    return this.withTransaction(async (client) => {
      const record = await this.lockEmail(client, id);
      if (
        !record ||
        (fromStatuses !== undefined && !fromStatuses.includes(record.status))
      ) {
        return undefined;
      }
      const updated = { ...record, ...structuredClone(updates) };
      await this.writeEmail(client, updated);
      return updated;
    });
  }

  async rescheduleEmailAndOutbox(
    id: string,
    scheduledAt: string,
    now: Date,
  ): Promise<EmailRecord | undefined> {
    return this.withTransaction(async (client) => {
      const result = await client.query<RescheduleRow>(
        `SELECT email.entity AS email_entity,
                message.entity AS message_entity,
                outbox.entity AS outbox_entity,
                outbox.id AS outbox_id,
                outbox.dispatched_at,
                outbox.lease_owner
         FROM emails AS email
         JOIN delivery_messages AS message ON message.id = email.id
         JOIN outbox_items AS outbox ON outbox.message_id = message.id
         WHERE email.id = $1
         FOR UPDATE OF email, message, outbox`,
        [id],
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }
      const email = parseEntity<EmailRecord>(row.email_entity);
      if (
        !["queued", "scheduled"].includes(email.status) ||
        row.dispatched_at !== null ||
        row.lease_owner !== null
      ) {
        return undefined;
      }
      const timestamp = now.toISOString();
      const updatedEmail: EmailRecord = {
        ...email,
        scheduled_at: scheduledAt,
        status: "scheduled",
        last_event: "scheduled",
        updated_at: timestamp,
      };
      const message = {
        ...parseEntity<Record<string, unknown>>(row.message_entity),
        scheduled_at: scheduledAt,
        status: "scheduled",
        updated_at: timestamp,
      };
      const outbox = {
        ...parseEntity<Record<string, unknown>>(row.outbox_entity),
        due_at: scheduledAt,
        updated_at: timestamp,
      };
      await this.writeEmail(client, updatedEmail);
      await client.query(
        "UPDATE delivery_messages SET entity = $1::jsonb, updated_at = $2 WHERE id = $3",
        [JSON.stringify(message), timestamp, id],
      );
      await client.query(
        "UPDATE outbox_items SET due_at = $1, entity = $2::jsonb, updated_at = $3 WHERE id = $4",
        [scheduledAt, JSON.stringify(outbox), timestamp, row.outbox_id],
      );
      return updatedEmail;
    });
  }

  async listEmails(limit: number, cursor?: string): Promise<Page<EmailRecord>> {
    let anchor: { created_at: Date; id: string } | undefined;
    if (cursor) {
      const result = await this.pool.query<{
        created_at: Date;
        id: string;
      }>("SELECT created_at, id FROM emails WHERE id = $1", [cursor]);
      anchor = result.rows[0];
      if (!anchor) {
        throw new ValidationError("The pagination cursor is invalid.");
      }
    }
    const result = await this.pool.query<EntityRow>(
      `SELECT id, entity, created_at
       FROM emails
       WHERE (
         $1::timestamptz IS NULL
         OR (created_at, id) < ($1::timestamptz, $2::text)
       )
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [anchor?.created_at ?? null, anchor?.id ?? null, limit + 1],
    );
    return resultPage<EmailRecord>(result.rows, limit);
  }

  async createTemplate(record: TemplateRecord): Promise<void> {
    try {
      await this.withTransaction(async (client) => {
        await this.insertAppEntity(client, "template", record, {
          revision: record.revision,
        });
        if (record.draft.alias !== undefined) {
          await client.query(
            "INSERT INTO template_aliases(alias_type, alias, template_id) VALUES ('draft', $1, $2)",
            [record.draft.alias, record.id],
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Template alias is already in use.");
      }
      throw error;
    }
  }

  async getTemplate(identifier: string): Promise<TemplateRecord | undefined> {
    const direct = await this.getAppEntity<TemplateRecord>(
      "template",
      identifier,
    );
    if (direct) {
      return direct;
    }
    const id = await this.resolveTemplateAlias("draft", identifier);
    return id
      ? this.getAppEntity<TemplateRecord>("template", id)
      : undefined;
  }

  async getPublishedTemplate(
    identifier: string,
  ): Promise<TemplateRecord | undefined> {
    const direct = await this.getAppEntity<TemplateRecord>(
      "template",
      identifier,
    );
    if (direct) {
      return direct;
    }
    const publishedId = await this.resolveTemplateAlias(
      "published",
      identifier,
    );
    if (publishedId) {
      return this.getAppEntity<TemplateRecord>("template", publishedId);
    }
    const draftId = await this.resolveTemplateAlias("draft", identifier);
    const candidate = draftId
      ? await this.getAppEntity<TemplateRecord>("template", draftId)
      : undefined;
    return candidate &&
      (!candidate.published || candidate.published.alias === identifier)
      ? candidate
      : undefined;
  }

  async replaceTemplate(
    record: TemplateRecord,
    previousAlias: string | undefined,
    expectedRevision: number,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const current = await this.lockAppEntity<TemplateRecord>(
        client,
        "template",
        record.id,
      );
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      const nextAlias = record.draft.alias;
      if (previousAlias !== undefined && previousAlias !== nextAlias) {
        await client.query(
          "DELETE FROM template_aliases WHERE alias_type = 'draft' AND alias = $1 AND template_id = $2",
          [previousAlias, record.id],
        );
      }
      if (
        nextAlias !== undefined &&
        !(await this.putTemplateAlias(client, "draft", nextAlias, record.id))
      ) {
        throw new ConflictError("Template alias is already in use.");
      }
      await this.writeAppEntity(client, "template", record, {
        revision: record.revision,
      });
      return true;
    });
  }

  async publishTemplate(
    record: TemplateRecord,
    publication: TemplatePublicationRecord,
    previousPublishedAlias: string | undefined,
    expectedRevision: number,
    historyLimit: number,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const current = await this.lockAppEntity<TemplateRecord>(
        client,
        "template",
        record.id,
      );
      if (
        !current ||
        current.revision !== expectedRevision ||
        publication.template_id !== record.id ||
        publication.id !== publication.version.id
      ) {
        return false;
      }
      const existing = await this.getAppEntityUsing<TemplatePublicationRecord>(
        client,
        "template_publication",
        publication.id,
      );
      if (existing) {
        return false;
      }
      const nextAlias = record.published?.alias;
      if (
        previousPublishedAlias !== undefined &&
        previousPublishedAlias !== nextAlias
      ) {
        await client.query(
          "DELETE FROM template_aliases WHERE alias_type = 'published' AND alias = $1 AND template_id = $2",
          [previousPublishedAlias, record.id],
        );
      }
      if (
        nextAlias !== undefined &&
        !(await this.putTemplateAlias(
          client,
          "published",
          nextAlias,
          record.id,
        ))
      ) {
        throw new ConflictError("Template alias is already in use.");
      }
      await this.insertAppEntity(
        client,
        "template_publication",
        publication,
        {
          scope: record.id,
          createdAt: publication.published_at,
          updatedAt: publication.published_at,
          expiresAt: publication.expires_at,
        },
      );
      await client.query(
        `DELETE FROM app_entities
         WHERE kind = 'template_publication'
           AND scope = $1
           AND id IN (
             SELECT id
             FROM app_entities
             WHERE kind = 'template_publication' AND scope = $1
             ORDER BY created_at DESC, id DESC
             OFFSET $2
           )`,
        [record.id, historyLimit],
      );
      await this.writeAppEntity(client, "template", record, {
        revision: record.revision,
      });
      return true;
    });
  }

  async getTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<TemplatePublicationRecord | undefined> {
    const version =
      await this.getAppEntity<TemplatePublicationRecord>(
        "template_publication",
        versionId,
      );
    return version?.template_id === templateId ? version : undefined;
  }

  async listTemplateVersions(
    templateId: string,
    limit: number,
    cursor: TemplatePublicationRecord | undefined,
    nowEpochSeconds: number,
  ): Promise<Page<TemplatePublicationRecord>> {
    if (cursor && cursor.template_id !== templateId) {
      throw new ValidationError("The pagination cursor is invalid.");
    }
    const result = await this.pool.query<EntityRow>(
      `SELECT id, entity, created_at
       FROM app_entities
       WHERE kind = 'template_publication'
         AND scope = $1
         AND expires_at > to_timestamp($2)
         AND (
           $3::timestamptz IS NULL
           OR (created_at, id) < ($3::timestamptz, $4::text)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [
        templateId,
        nowEpochSeconds,
        cursor?.published_at ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    return resultPage<TemplatePublicationRecord>(result.rows, limit);
  }

  async deleteTemplate(
    record: TemplateRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const current = await this.lockAppEntity<TemplateRecord>(
        client,
        "template",
        record.id,
      );
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      await client.query(
        "DELETE FROM template_aliases WHERE template_id = $1",
        [record.id],
      );
      await client.query(
        "DELETE FROM app_entities WHERE kind = 'template_publication' AND scope = $1",
        [record.id],
      );
      await client.query(
        "DELETE FROM app_entities WHERE kind = 'template' AND id = $1",
        [record.id],
      );
      return true;
    });
  }

  async listTemplates(
    limit: number,
    cursor?: string,
    direction: "after" | "before" = "after",
  ): Promise<Page<TemplateRecord>> {
    if (direction === "after") {
      return this.pageAppEntities<TemplateRecord>(
        "template",
        limit,
        cursor,
      );
    }
    const anchor = cursor
      ? await this.getAppEntityAnchor("template", cursor)
      : undefined;
    if (cursor && !anchor) {
      throw new ValidationError("The pagination cursor is invalid.");
    }
    const result = await this.pool.query<EntityRow>(
      `SELECT id, entity, created_at
       FROM app_entities
       WHERE kind = 'template'
         AND (
           $1::timestamptz IS NULL
           OR (created_at, id) > ($1::timestamptz, $2::text)
         )
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
      [anchor?.created_at ?? null, anchor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const data = result.rows
      .slice(0, limit)
      .map((row) => parseEntity<TemplateRecord>(row.entity))
      .reverse();
    return hasMore && data.length > 0
      ? { data, has_more: true, next_cursor: data[0]?.id }
      : { data, has_more: false };
  }

  async putAttachmentUpload(record: AttachmentUploadRecord): Promise<void> {
    await this.putAppEntity("attachment_upload", record, {
      expiresAt: record.expires_at,
    });
  }

  async getAttachmentUpload(
    id: string,
  ): Promise<AttachmentUploadRecord | undefined> {
    return this.getAppEntity<AttachmentUploadRecord>("attachment_upload", id);
  }

  async claimReceivedEmail(
    id: string,
    now: number,
    leaseUntil: number,
    expiresAt: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO received_email_claims(id, lease_until, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET lease_until = EXCLUDED.lease_until,
           expires_at = EXCLUDED.expires_at
       WHERE received_email_claims.lease_until < $4
       RETURNING id`,
      [id, leaseUntil, expiresAt, now],
    );
    return result.rowCount === 1;
  }

  async releaseReceivedEmailClaim(
    id: string,
    leaseUntil: number,
  ): Promise<void> {
    await this.pool.query(
      "DELETE FROM received_email_claims WHERE id = $1 AND lease_until = $2",
      [id, leaseUntil],
    );
  }

  async createReceivedEmail(record: ReceivedEmailRecord): Promise<boolean> {
    return this.createAppEntity("received_email", record, {
      expiresAt: record.expires_at,
    });
  }

  async getReceivedEmail(
    id: string,
  ): Promise<ReceivedEmailRecord | undefined> {
    return this.getAppEntity<ReceivedEmailRecord>("received_email", id);
  }

  async updateReceivedEmail(
    id: string,
    updates: Partial<ReceivedEmailRecord>,
  ): Promise<ReceivedEmailRecord | undefined> {
    return this.updateAppEntity("received_email", id, updates, (record) => ({
      expiresAt: record.expires_at,
    }));
  }

  async listReceivedEmails(
    limit: number,
    cursor?: string,
  ): Promise<Page<ReceivedEmailRecord>> {
    return this.pageAppEntities(
      "received_email",
      limit,
      cursor,
      undefined,
      true,
    );
  }

  async createDomain(record: DomainRecord): Promise<void> {
    await this.putAppEntity("domain", record);
  }

  async getDomain(id: string): Promise<DomainRecord | undefined> {
    return this.getAppEntity<DomainRecord>("domain", id);
  }

  async updateDomain(
    id: string,
    updates: Partial<DomainRecord>,
  ): Promise<DomainRecord | undefined> {
    return this.updateAppEntity("domain", id, updates);
  }

  async deleteDomain(id: string): Promise<boolean> {
    return this.deleteAppEntity("domain", id);
  }

  async listDomains(
    limit: number,
    cursor?: string,
  ): Promise<Page<DomainRecord>> {
    return this.pageAppEntities("domain", limit, cursor);
  }

  async createWebhook(record: WebhookEndpoint): Promise<void> {
    await this.putAppEntity("webhook", record);
  }

  async getWebhook(id: string): Promise<WebhookEndpoint | undefined> {
    return this.getAppEntity<WebhookEndpoint>("webhook", id);
  }

  async updateWebhook(
    id: string,
    updates: Partial<
      Pick<WebhookEndpoint, "endpoint" | "events" | "status">
    >,
  ): Promise<WebhookEndpoint | undefined> {
    return this.updateAppEntity("webhook", id, updates);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    return this.deleteAppEntity("webhook", id);
  }

  async listWebhooks(
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookEndpoint>> {
    return this.pageAppEntities("webhook", limit, cursor);
  }

  async createWebhookDelivery(
    record: WebhookDeliveryRecord,
  ): Promise<boolean> {
    return this.createAppEntity("webhook_delivery", record, {
      scope: record.webhook_id,
      expiresAt: record.expires_at,
    });
  }

  async getWebhookDelivery(
    id: string,
  ): Promise<WebhookDeliveryRecord | undefined> {
    return this.getAppEntity<WebhookDeliveryRecord>(
      "webhook_delivery",
      id,
      true,
    );
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
    return this.updateAppEntity(
      "webhook_delivery",
      id,
      updates,
      (record) => ({
        scope: record.webhook_id,
        expiresAt: record.expires_at,
      }),
      true,
    );
  }

  async listWebhookDeliveries(
    webhookId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookDeliveryRecord>> {
    return this.pageAppEntities(
      "webhook_delivery",
      limit,
      cursor,
      webhookId,
      true,
    );
  }

  async createApiKey(record: ApiKeyRecord): Promise<void> {
    await this.putAppEntity("api_key", record, {
      expiresAt: record.expires_at,
    });
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    return this.getAppEntity<ApiKeyRecord>("api_key", id);
  }

  async updateApiKey(
    id: string,
    updates: Partial<ApiKeyRecord>,
  ): Promise<ApiKeyRecord | undefined> {
    return this.updateAppEntity("api_key", id, updates, (record) => ({
      expiresAt: record.expires_at,
    }));
  }

  async listApiKeys(
    limit: number,
    cursor?: string,
  ): Promise<Page<ApiKeyRecord>> {
    return this.pageAppEntities("api_key", limit, cursor);
  }

  async putSuppression(record: SuppressionRecord): Promise<void> {
    await this.putAppEntity("suppression", record);
  }

  async getSuppression(
    emailHash: string,
  ): Promise<SuppressionRecord | undefined> {
    return this.getAppEntity<SuppressionRecord>("suppression", emailHash);
  }

  async deleteSuppression(emailHash: string): Promise<boolean> {
    return this.deleteAppEntity("suppression", emailHash);
  }

  async listSuppressions(
    limit: number,
    cursor?: string,
  ): Promise<Page<SuppressionRecord>> {
    return this.pageAppEntities("suppression", limit, cursor);
  }

  private async lockEmail(
    client: PoolClient,
    id: string,
  ): Promise<EmailRecord | undefined> {
    const result = await client.query<EmailRow>(
      "SELECT entity FROM emails WHERE id = $1 FOR UPDATE",
      [id],
    );
    const row = result.rows[0];
    return row ? parseEntity<EmailRecord>(row.entity) : undefined;
  }

  private async writeEmail(
    client: PoolClient,
    record: EmailRecord,
  ): Promise<void> {
    await client.query(
      "UPDATE emails SET entity = $1::jsonb, updated_at = $2 WHERE id = $3",
      [JSON.stringify(record), record.updated_at, record.id],
    );
  }

  private async resolveTemplateAlias(
    aliasType: "draft" | "published",
    alias: string,
  ): Promise<string | undefined> {
    const result = await this.pool.query<{ template_id: string }>(
      "SELECT template_id FROM template_aliases WHERE alias_type = $1 AND alias = $2",
      [aliasType, alias],
    );
    return result.rows[0]?.template_id;
  }

  private async putTemplateAlias(
    client: PoolClient,
    aliasType: "draft" | "published",
    alias: string,
    templateId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO template_aliases(alias_type, alias, template_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (alias_type, alias) DO UPDATE
       SET template_id = EXCLUDED.template_id
       WHERE template_aliases.template_id = EXCLUDED.template_id
       RETURNING template_id`,
      [aliasType, alias, templateId],
    );
    return result.rowCount === 1;
  }

  private async getAppEntity<T>(
    kind: AppEntityKind,
    id: string,
    activeOnly = false,
  ): Promise<T | undefined> {
    return this.getAppEntityUsing<T>(this.pool, kind, id, activeOnly);
  }

  private async getAppEntityUsing<T>(
    queryable: Pick<PoolClient, "query">,
    kind: AppEntityKind,
    id: string,
    activeOnly = false,
  ): Promise<T | undefined> {
    const result = await queryable.query<EmailRow>(
      `SELECT entity
       FROM app_entities
       WHERE kind = $1
         AND id = $2
         AND (NOT $3::boolean OR expires_at > clock_timestamp())`,
      [kind, id, activeOnly],
    );
    const row = result.rows[0];
    return row ? parseEntity<T>(row.entity) : undefined;
  }

  private async lockAppEntity<T>(
    client: PoolClient,
    kind: AppEntityKind,
    id: string,
    activeOnly = false,
  ): Promise<T | undefined> {
    const result = await client.query<EmailRow>(
      `SELECT entity
       FROM app_entities
       WHERE kind = $1
         AND id = $2
         AND (NOT $3::boolean OR expires_at > clock_timestamp())
       FOR UPDATE`,
      [kind, id, activeOnly],
    );
    const row = result.rows[0];
    return row ? parseEntity<T>(row.entity) : undefined;
  }

  private async getAppEntityAnchor(
    kind: AppEntityKind,
    id: string,
    scope?: string,
    activeOnly = false,
  ): Promise<{ created_at: Date; id: string } | undefined> {
    const result = await this.pool.query<{
      created_at: Date;
      id: string;
    }>(
      `SELECT created_at, id
       FROM app_entities
       WHERE kind = $1
         AND id = $2
         AND ($3::text IS NULL OR scope = $3)
         AND (NOT $4::boolean OR expires_at > clock_timestamp())`,
      [kind, id, scope ?? null, activeOnly],
    );
    return result.rows[0];
  }

  private async pageAppEntities<T extends { id: string }>(
    kind: AppEntityKind,
    limit: number,
    cursor?: string,
    scope?: string,
    activeOnly = false,
  ): Promise<Page<T>> {
    const anchor = cursor
      ? await this.getAppEntityAnchor(kind, cursor, scope, activeOnly)
      : undefined;
    if (cursor && !anchor) {
      throw new ValidationError("The pagination cursor is invalid.");
    }
    const result = await this.pool.query<EntityRow>(
      `SELECT id, entity, created_at
       FROM app_entities
       WHERE kind = $1
         AND ($2::text IS NULL OR scope = $2)
         AND (NOT $3::boolean OR expires_at > clock_timestamp())
         AND (
           $4::timestamptz IS NULL
           OR (created_at, id) < ($4::timestamptz, $5::text)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $6`,
      [
        kind,
        scope ?? null,
        activeOnly,
        anchor?.created_at ?? null,
        anchor?.id ?? null,
        limit + 1,
      ],
    );
    return resultPage<T>(result.rows, limit);
  }

  private async insertAppEntity<T extends { id: string }>(
    queryable: Pick<PoolClient, "query">,
    kind: AppEntityKind,
    record: T,
    options: {
      scope?: string | undefined;
      createdAt?: string | undefined;
      updatedAt?: string | undefined;
      expiresAt?: string | undefined;
      revision?: number | undefined;
    } = {},
  ): Promise<void> {
    const timestamps = record as T & {
      created_at?: string;
      updated_at?: string;
    };
    const createdAt =
      options.createdAt ?? timestamps.created_at ?? new Date().toISOString();
    const updatedAt = options.updatedAt ?? timestamps.updated_at ?? createdAt;
    await queryable.query(
      `INSERT INTO app_entities(
         kind, id, scope, entity, created_at, updated_at, expires_at, revision
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        kind,
        record.id,
        options.scope ?? null,
        JSON.stringify(record),
        createdAt,
        updatedAt,
        options.expiresAt ?? null,
        options.revision ?? null,
      ],
    );
  }

  private async createAppEntity<T extends { id: string }>(
    kind: AppEntityKind,
    record: T,
    options: {
      scope?: string | undefined;
      expiresAt?: string | undefined;
    } = {},
  ): Promise<boolean> {
    try {
      await this.insertAppEntity(this.pool, kind, record, options);
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  private async putAppEntity<T extends { id: string }>(
    kind: AppEntityKind,
    record: T,
    options: {
      scope?: string | undefined;
      expiresAt?: string | undefined;
    } = {},
  ): Promise<void> {
    const timestamps = record as T & {
      created_at?: string;
      updated_at?: string;
    };
    const createdAt = timestamps.created_at ?? new Date().toISOString();
    const updatedAt = timestamps.updated_at ?? createdAt;
    await this.pool.query(
      `INSERT INTO app_entities(
         kind, id, scope, entity, created_at, updated_at, expires_at, revision
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NULL)
       ON CONFLICT (kind, id) DO UPDATE
       SET scope = EXCLUDED.scope,
           entity = EXCLUDED.entity,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           expires_at = EXCLUDED.expires_at`,
      [
        kind,
        record.id,
        options.scope ?? null,
        JSON.stringify(record),
        createdAt,
        updatedAt,
        options.expiresAt ?? null,
      ],
    );
  }

  private async writeAppEntity<T extends { id: string }>(
    client: PoolClient,
    kind: AppEntityKind,
    record: T,
    options: {
      scope?: string | undefined;
      expiresAt?: string | undefined;
      revision?: number | undefined;
    } = {},
  ): Promise<void> {
    const timestamps = record as T & {
      updated_at?: string;
    };
    await client.query(
      `UPDATE app_entities
       SET scope = $1,
           entity = $2::jsonb,
           updated_at = $3,
           expires_at = $4,
           revision = $5
       WHERE kind = $6 AND id = $7`,
      [
        options.scope ?? null,
        JSON.stringify(record),
        timestamps.updated_at ?? new Date().toISOString(),
        options.expiresAt ?? null,
        options.revision ?? null,
        kind,
        record.id,
      ],
    );
  }

  private async updateAppEntity<T extends { id: string }, U extends object>(
    kind: AppEntityKind,
    id: string,
    updates: U,
    options?: ((record: T) => {
      scope?: string | undefined;
      expiresAt?: string | undefined;
    }),
    activeOnly = false,
  ): Promise<T | undefined> {
    return this.withTransaction(async (client) => {
      const record = await this.lockAppEntity<T>(
        client,
        kind,
        id,
        activeOnly,
      );
      if (!record) {
        return undefined;
      }
      const updated = { ...record, ...structuredClone(updates) };
      await this.writeAppEntity(
        client,
        kind,
        updated,
        options?.(updated),
      );
      return updated;
    });
  }

  private async deleteAppEntity(
    kind: AppEntityKind,
    id: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM app_entities WHERE kind = $1 AND id = $2",
      [kind, id],
    );
    return result.rowCount === 1;
  }
}
