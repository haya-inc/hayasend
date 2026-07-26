import { ConflictError } from "../core/errors.js";
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
import type { Store } from "../ports/store.js";

interface IdempotencyEntry extends IdempotencyClaim {
  email_id: string;
}

function pageFromMap<T extends { created_at: string }>(
  values: Iterable<T>,
  limit: number,
  cursor?: string,
): Page<T> {
  const offset = cursor
    ? Number(Buffer.from(cursor, "base64url").toString("utf8"))
    : 0;
  const sorted = [...values].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  );
  const data = sorted
    .slice(offset, offset + limit)
    .map((item) => structuredClone(item));
  const nextOffset = offset + data.length;
  if (nextOffset < sorted.length) {
    return {
      data,
      has_more: true,
      next_cursor: Buffer.from(String(nextOffset)).toString("base64url"),
    };
  }
  return { data, has_more: false };
}

export class MemoryStore implements Store {
  private readonly emails = new Map<string, EmailRecord>();
  private readonly attachmentUploads = new Map<
    string,
    AttachmentUploadRecord
  >();
  private readonly receivedEmails = new Map<string, ReceivedEmailRecord>();
  private readonly receivedClaims = new Map<string, number>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly domains = new Map<string, DomainRecord>();
  private readonly webhooks = new Map<string, WebhookEndpoint>();
  private readonly webhookDeliveries = new Map<string, WebhookDeliveryRecord>();
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly suppressions = new Map<string, SuppressionRecord>();
  private readonly templates = new Map<string, TemplateRecord>();
  private readonly templateAliases = new Map<string, string>();
  private readonly publishedTemplateAliases = new Map<string, string>();
  private readonly templateVersions = new Map<
    string,
    Map<string, TemplatePublicationRecord>
  >();

  async createEmail(
    record: EmailRecord,
    idempotency?: IdempotencyClaim,
  ): Promise<CreateEmailResult> {
    if (idempotency) {
      const existingClaim = this.idempotency.get(idempotency.key_hash);
      if (
        existingClaim &&
        existingClaim.expires_at > Math.floor(Date.now() / 1_000)
      ) {
        if (existingClaim.request_hash !== idempotency.request_hash) {
          throw new ConflictError(
            "The Idempotency-Key has already been used with a different request.",
          );
        }
        const existingEmail = this.emails.get(existingClaim.email_id);
        if (!existingEmail) {
          throw new ConflictError(
            "The idempotent request exists but its email record is unavailable.",
          );
        }
        return { record: structuredClone(existingEmail), replayed: true };
      }
    }

    this.emails.set(record.id, structuredClone(record));
    if (idempotency) {
      this.idempotency.set(idempotency.key_hash, {
        ...idempotency,
        email_id: record.id,
      });
    }
    return { record: structuredClone(record), replayed: false };
  }

  async getEmail(id: string): Promise<EmailRecord | undefined> {
    const record = this.emails.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async claimEmailForSend(
    id: string,
    attempt: number,
    now: Date,
  ): Promise<EmailRecord | undefined> {
    const record = this.emails.get(id);
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
    this.emails.set(id, updated);
    return structuredClone(updated);
  }

  async updateEmail(
    id: string,
    updates: Partial<EmailRecord>,
    fromStatuses?: EmailStatus[],
  ): Promise<EmailRecord | undefined> {
    const record = this.emails.get(id);
    if (
      !record ||
      (fromStatuses !== undefined && !fromStatuses.includes(record.status))
    ) {
      return undefined;
    }
    const updated = { ...record, ...structuredClone(updates) };
    this.emails.set(id, updated);
    return structuredClone(updated);
  }

  async listEmails(limit: number, cursor?: string): Promise<Page<EmailRecord>> {
    return pageFromMap(this.emails.values(), limit, cursor);
  }

  async createTemplate(record: TemplateRecord): Promise<void> {
    const alias = record.draft.alias;
    if (
      this.templates.has(record.id) ||
      (alias !== undefined && this.templateAliases.has(alias))
    ) {
      throw new ConflictError("Template alias is already in use.");
    }
    this.templates.set(record.id, structuredClone(record));
    if (alias !== undefined) {
      this.templateAliases.set(alias, record.id);
    }
  }

  async getTemplate(identifier: string): Promise<TemplateRecord | undefined> {
    const id = this.templates.has(identifier)
      ? identifier
      : this.templateAliases.get(identifier);
    const record = id ? this.templates.get(id) : undefined;
    return record ? structuredClone(record) : undefined;
  }

  async getPublishedTemplate(
    identifier: string,
  ): Promise<TemplateRecord | undefined> {
    const id = this.templates.has(identifier)
      ? identifier
      : this.publishedTemplateAliases.get(identifier);
    const draftAliasRecord = this.templateAliases.get(identifier);
    const draftCandidate = draftAliasRecord
      ? this.templates.get(draftAliasRecord)
      : undefined;
    const record =
      (id ? this.templates.get(id) : undefined) ??
      (draftCandidate &&
      (!draftCandidate.published ||
        draftCandidate.published.alias === identifier)
        ? draftCandidate
        : undefined) ??
      [...this.templates.values()].find(
        (candidate) => candidate.published?.alias === identifier,
      );
    return record ? structuredClone(record) : undefined;
  }

  async replaceTemplate(
    record: TemplateRecord,
    previousAlias: string | undefined,
    expectedRevision: number,
  ): Promise<boolean> {
    const current = this.templates.get(record.id);
    if (!current || current.revision !== expectedRevision) {
      return false;
    }
    const nextAlias = record.draft.alias;
    const aliasOwner =
      nextAlias === undefined ? undefined : this.templateAliases.get(nextAlias);
    if (aliasOwner !== undefined && aliasOwner !== record.id) {
      throw new ConflictError("Template alias is already in use.");
    }
    if (previousAlias !== undefined && previousAlias !== nextAlias) {
      this.templateAliases.delete(previousAlias);
    }
    if (nextAlias !== undefined) {
      this.templateAliases.set(nextAlias, record.id);
    }
    this.templates.set(record.id, structuredClone(record));
    return true;
  }

  async publishTemplate(
    record: TemplateRecord,
    publication: TemplatePublicationRecord,
    previousPublishedAlias: string | undefined,
    expectedRevision: number,
    historyLimit: number,
  ): Promise<boolean> {
    const current = this.templates.get(record.id);
    if (
      !current ||
      current.revision !== expectedRevision ||
      publication.template_id !== record.id ||
      publication.id !== publication.version.id
    ) {
      return false;
    }
    const versions =
      this.templateVersions.get(record.id) ??
      new Map<string, TemplatePublicationRecord>();
    if (versions.has(publication.id)) {
      return false;
    }
    const nextPublishedAlias = record.published?.alias;
    const aliasOwner =
      nextPublishedAlias === undefined
        ? undefined
        : this.publishedTemplateAliases.get(nextPublishedAlias);
    if (aliasOwner !== undefined && aliasOwner !== record.id) {
      throw new ConflictError("Template alias is already in use.");
    }

    const retained = [...versions.values(), structuredClone(publication)]
      .sort(
        (left, right) =>
          right.published_at.localeCompare(left.published_at) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, historyLimit);
    versions.clear();
    for (const version of retained) {
      versions.set(version.id, version);
    }
    this.templateVersions.set(record.id, versions);
    if (
      previousPublishedAlias !== undefined &&
      previousPublishedAlias !== nextPublishedAlias
    ) {
      this.publishedTemplateAliases.delete(previousPublishedAlias);
    }
    if (nextPublishedAlias !== undefined) {
      this.publishedTemplateAliases.set(nextPublishedAlias, record.id);
    }
    this.templates.set(record.id, structuredClone(record));
    return true;
  }

  async getTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<TemplatePublicationRecord | undefined> {
    const record = this.templateVersions.get(templateId)?.get(versionId);
    return record ? structuredClone(record) : undefined;
  }

  async listTemplateVersions(
    templateId: string,
    limit: number,
    cursor: TemplatePublicationRecord | undefined,
    nowEpochSeconds: number,
  ): Promise<Page<TemplatePublicationRecord>> {
    const versions = [
      ...(this.templateVersions.get(templateId)?.values() ?? []),
    ].sort(
      (left, right) =>
        right.published_at.localeCompare(left.published_at) ||
        right.id.localeCompare(left.id),
    );
    const cursorIndex = cursor
      ? versions.findIndex((version) => version.id === cursor.id)
      : -1;
    const eligible = versions
      .slice(cursorIndex >= 0 ? cursorIndex + 1 : 0)
      .filter(
        (version) =>
          Math.floor(Date.parse(version.expires_at) / 1_000) > nowEpochSeconds,
      );
    const data = eligible
      .slice(0, limit)
      .map((version) => structuredClone(version));
    return eligible.length > limit && data.length > 0
      ? {
          data,
          has_more: true,
          next_cursor: data.at(-1)?.id,
        }
      : { data, has_more: false };
  }

  async deleteTemplate(
    record: TemplateRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const current = this.templates.get(record.id);
    if (!current || current.revision !== expectedRevision) {
      return false;
    }
    this.templates.delete(record.id);
    if (current.draft.alias !== undefined) {
      this.templateAliases.delete(current.draft.alias);
    }
    if (current.published?.alias !== undefined) {
      this.publishedTemplateAliases.delete(current.published.alias);
    }
    this.templateVersions.delete(record.id);
    return true;
  }

  async listTemplates(
    limit: number,
    cursor?: string,
    direction: "after" | "before" = "after",
  ): Promise<Page<TemplateRecord>> {
    const sorted = [...this.templates.values()].sort((left, right) =>
      right.created_at.localeCompare(left.created_at),
    );
    const cursorIndex = cursor
      ? sorted.findIndex((record) => record.id === cursor)
      : -1;
    const offset =
      direction === "before"
        ? Math.max(0, cursorIndex - limit)
        : cursorIndex >= 0
          ? cursorIndex + 1
          : 0;
    const end =
      direction === "before" && cursorIndex >= 0 ? cursorIndex : offset + limit;
    const data = sorted
      .slice(offset, end)
      .map((record) => structuredClone(record));
    const hasMore =
      direction === "before"
        ? offset > 0
        : offset + data.length < sorted.length;
    return hasMore && data.length > 0
      ? {
          data,
          has_more: true,
          next_cursor: direction === "before" ? data[0]?.id : data.at(-1)?.id,
        }
      : { data, has_more: false };
  }

  async putAttachmentUpload(record: AttachmentUploadRecord): Promise<void> {
    this.attachmentUploads.set(record.id, structuredClone(record));
  }

  async getAttachmentUpload(
    id: string,
  ): Promise<AttachmentUploadRecord | undefined> {
    const record = this.attachmentUploads.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async claimReceivedEmail(
    id: string,
    now: number,
    leaseUntil: number,
    _expiresAt: number,
  ): Promise<boolean> {
    const currentLease = this.receivedClaims.get(id);
    if (currentLease !== undefined && currentLease >= now) {
      return false;
    }
    this.receivedClaims.set(id, leaseUntil);
    return true;
  }

  async releaseReceivedEmailClaim(
    id: string,
    leaseUntil: number,
  ): Promise<void> {
    if (this.receivedClaims.get(id) === leaseUntil) {
      this.receivedClaims.delete(id);
    }
  }

  async createReceivedEmail(record: ReceivedEmailRecord): Promise<boolean> {
    if (this.receivedEmails.has(record.id)) {
      return false;
    }
    this.receivedEmails.set(record.id, structuredClone(record));
    return true;
  }

  async getReceivedEmail(id: string): Promise<ReceivedEmailRecord | undefined> {
    const record = this.receivedEmails.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async updateReceivedEmail(
    id: string,
    updates: Partial<ReceivedEmailRecord>,
  ): Promise<ReceivedEmailRecord | undefined> {
    const record = this.receivedEmails.get(id);
    if (!record) {
      return undefined;
    }
    const updated = { ...record, ...structuredClone(updates) };
    this.receivedEmails.set(id, updated);
    return structuredClone(updated);
  }

  async listReceivedEmails(
    limit: number,
    cursor?: string,
  ): Promise<Page<ReceivedEmailRecord>> {
    return pageFromMap(this.receivedEmails.values(), limit, cursor);
  }

  async createDomain(record: DomainRecord): Promise<void> {
    this.domains.set(record.id, structuredClone(record));
  }

  async getDomain(id: string): Promise<DomainRecord | undefined> {
    const record = this.domains.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async updateDomain(
    id: string,
    updates: Partial<DomainRecord>,
  ): Promise<DomainRecord | undefined> {
    const record = this.domains.get(id);
    if (!record) {
      return undefined;
    }
    const updated = { ...record, ...structuredClone(updates) };
    this.domains.set(id, updated);
    return structuredClone(updated);
  }

  async deleteDomain(id: string): Promise<boolean> {
    return this.domains.delete(id);
  }

  async listDomains(
    limit: number,
    cursor?: string,
  ): Promise<Page<DomainRecord>> {
    return pageFromMap(this.domains.values(), limit, cursor);
  }

  async createWebhook(record: WebhookEndpoint): Promise<void> {
    this.webhooks.set(record.id, structuredClone(record));
  }

  async getWebhook(id: string): Promise<WebhookEndpoint | undefined> {
    const record = this.webhooks.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async updateWebhook(
    id: string,
    updates: Partial<Pick<WebhookEndpoint, "endpoint" | "events" | "status">>,
  ): Promise<WebhookEndpoint | undefined> {
    const record = this.webhooks.get(id);
    if (!record) {
      return undefined;
    }
    const updated = { ...record, ...structuredClone(updates) };
    this.webhooks.set(id, updated);
    return structuredClone(updated);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    return this.webhooks.delete(id);
  }

  async listWebhooks(
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookEndpoint>> {
    return pageFromMap(this.webhooks.values(), limit, cursor);
  }

  async createWebhookDelivery(record: WebhookDeliveryRecord): Promise<boolean> {
    if (this.webhookDeliveries.has(record.id)) {
      return false;
    }
    this.webhookDeliveries.set(record.id, structuredClone(record));
    return true;
  }

  async getWebhookDelivery(
    id: string,
  ): Promise<WebhookDeliveryRecord | undefined> {
    const record = this.webhookDeliveries.get(id);
    if (!record || Date.parse(record.expires_at) <= Date.now()) {
      return undefined;
    }
    return structuredClone(record);
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
    const record = await this.getWebhookDelivery(id);
    if (!record) {
      return undefined;
    }
    const updated = { ...record, ...structuredClone(updates) };
    this.webhookDeliveries.set(id, updated);
    return structuredClone(updated);
  }

  async listWebhookDeliveries(
    webhookId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookDeliveryRecord>> {
    return pageFromMap(
      [...this.webhookDeliveries.values()].filter(
        (record) =>
          record.webhook_id === webhookId &&
          Date.parse(record.expires_at) > Date.now(),
      ),
      limit,
      cursor,
    );
  }

  async createApiKey(record: ApiKeyRecord): Promise<void> {
    this.apiKeys.set(record.id, structuredClone(record));
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    const record = this.apiKeys.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async updateApiKey(
    id: string,
    updates: Partial<ApiKeyRecord>,
  ): Promise<ApiKeyRecord | undefined> {
    const record = this.apiKeys.get(id);
    if (!record) {
      return undefined;
    }
    const updated = { ...record, ...structuredClone(updates) };
    this.apiKeys.set(id, updated);
    return structuredClone(updated);
  }

  async listApiKeys(
    limit: number,
    cursor?: string,
  ): Promise<Page<ApiKeyRecord>> {
    return pageFromMap(this.apiKeys.values(), limit, cursor);
  }

  async putSuppression(record: SuppressionRecord): Promise<void> {
    this.suppressions.set(record.id, structuredClone(record));
  }

  async getSuppression(
    emailHash: string,
  ): Promise<SuppressionRecord | undefined> {
    const record = this.suppressions.get(emailHash);
    return record ? structuredClone(record) : undefined;
  }

  async deleteSuppression(emailHash: string): Promise<boolean> {
    return this.suppressions.delete(emailHash);
  }

  async listSuppressions(
    limit: number,
    cursor?: string,
  ): Promise<Page<SuppressionRecord>> {
    return pageFromMap(this.suppressions.values(), limit, cursor);
  }
}
