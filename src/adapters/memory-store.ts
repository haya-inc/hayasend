import { validateDeliveryCommit } from "../core/delivery-commit.js";
import {
  deliveryAttemptRecordSchema,
  deliveryDiagnosticCategorySchema,
  isEquivalentProviderEventReplay,
  outboxItemRecordSchema,
  providerEventRecordSchema,
  type DeliveryAttemptRecord,
  type DeliveryDiagnosticCategory,
  type DeliveryMessageRecord,
  type OutboxItemRecord,
  type ProviderEventRecord,
  type RecipientRecord,
} from "../core/delivery-model.js";
import {
  planAttemptCompletion,
  planAttemptStart,
  planLocalRecipientState,
  planProviderEvent,
  type AttemptCompletion,
  type DeliveryLedgerPlan,
} from "../core/recipient-ledger.js";
import { ConflictError, ValidationError } from "../core/errors.js";
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

interface IdempotencyEntry extends IdempotencyClaim {
  email_id: string;
}

export type MemoryDeliveryMutation =
  | {
      operation: "commit";
      entity: "email" | "message" | "recipient" | "idempotency" | "outbox";
      index?: number | undefined;
    }
  | {
      operation: "commit_swap" | "lease" | "acknowledge" | "failure";
      entity: "outbox";
    }
  | {
      operation: "ledger";
      entity:
        | "email"
        | "message"
        | "recipient"
        | "attempt"
        | "provider_event";
      index?: number | undefined;
    };

export interface MemoryStoreOptions {
  afterDeliveryMutation?:
    | ((mutation: MemoryDeliveryMutation) => void)
    | undefined;
}

function pageFromMap<T extends { id: string; created_at: string }>(
  values: Iterable<T>,
  limit: number,
  cursor?: string,
): Page<T> {
  const sorted = [...values].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) ||
      right.id.localeCompare(left.id),
  );
  const cursorIndex = cursor
    ? sorted.findIndex((record) => record.id === cursor)
    : -1;
  if (cursor && cursorIndex < 0) {
    throw new ValidationError("The pagination cursor is invalid.");
  }
  const offset = cursorIndex + 1;
  const data = sorted
    .slice(offset, offset + limit)
    .map((item) => structuredClone(item));
  if (offset + data.length < sorted.length && data.length > 0) {
    return {
      data,
      has_more: true,
      next_cursor: data.at(-1)?.id,
    };
  }
  return { data, has_more: false };
}

export class MemoryStore implements Store, DeliveryOutboxStore {
  private emails = new Map<string, EmailRecord>();
  private readonly attachmentUploads = new Map<
    string,
    AttachmentUploadRecord
  >();
  private readonly receivedEmails = new Map<string, ReceivedEmailRecord>();
  private readonly receivedClaims = new Map<string, number>();
  private idempotency = new Map<string, IdempotencyEntry>();
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
  private deliveryMessages = new Map<string, DeliveryMessageRecord>();
  private deliveryRecipients = new Map<string, RecipientRecord>();
  private deliveryAttempts = new Map<string, DeliveryAttemptRecord>();
  private providerEvents = new Map<string, ProviderEventRecord>();
  private outboxItems = new Map<string, OutboxItemRecord>();
  private outboxByMessage = new Map<string, string>();
  private outboxPublishFailures = 0;

  constructor(private readonly options: MemoryStoreOptions = {}) {}

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

  async rescheduleEmailAndOutbox(
    id: string,
    scheduledAt: string,
    now: Date,
  ): Promise<EmailRecord | undefined> {
    const email = this.emails.get(id);
    const message = this.deliveryMessages.get(id);
    const outboxId = this.outboxByMessage.get(id);
    const outbox = outboxId
      ? this.outboxItems.get(outboxId)
      : undefined;
    if (
      !email ||
      !["queued", "scheduled"].includes(email.status) ||
      !message ||
      !outbox ||
      outbox.dispatched_at !== undefined ||
      outbox.lease_owner !== undefined
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
    this.emails.set(id, updatedEmail);
    this.deliveryMessages.set(id, {
      ...message,
      scheduled_at: scheduledAt,
      status: "scheduled",
      updated_at: timestamp,
    });
    this.outboxItems.set(outbox.id, {
      ...outbox,
      due_at: scheduledAt,
      updated_at: timestamp,
    });
    return structuredClone(updatedEmail);
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
    const now = Date.now();
    return pageFromMap(
      [...this.receivedEmails.values()].filter(
        (record) => Date.parse(record.expires_at) > now,
      ),
      limit,
      cursor,
    );
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

  async commitDelivery(
    input: DeliveryCommit,
    nowEpochSeconds: number,
  ): Promise<DeliveryCommitResult> {
    const validated = validateDeliveryCommit(input, nowEpochSeconds);
    const { email, message, recipients, outbox, idempotency } = validated;

    if (idempotency) {
      const existingClaim = this.idempotency.get(idempotency.key_hash);
      if (
        existingClaim &&
        existingClaim.expires_at > nowEpochSeconds
      ) {
        if (existingClaim.request_hash !== idempotency.request_hash) {
          throw new ConflictError(
            "The Idempotency-Key has already been used with a different request.",
          );
        }
        const replay = this.deliveryResult(existingClaim.email_id, true);
        if (!replay) {
          throw new ConflictError(
            "The idempotent delivery exists but its atomic records are unavailable.",
          );
        }
        return replay;
      }
    }
    if (
      this.emails.has(email.id) ||
      this.deliveryMessages.has(message.id) ||
      this.outboxItems.has(outbox.id)
    ) {
      throw new ConflictError("Delivery identity is already in use.");
    }

    const nextEmails = new Map(this.emails);
    const nextIdempotency = new Map(this.idempotency);
    const nextMessages = new Map(this.deliveryMessages);
    const nextRecipients = new Map(this.deliveryRecipients);
    const nextOutbox = new Map(this.outboxItems);
    const nextOutboxByMessage = new Map(this.outboxByMessage);

    nextEmails.set(email.id, structuredClone(email));
    this.afterDeliveryMutation({ operation: "commit", entity: "email" });
    nextMessages.set(message.id, structuredClone(message));
    this.afterDeliveryMutation({ operation: "commit", entity: "message" });
    recipients.forEach((recipient, index) => {
      if (nextRecipients.has(recipient.id)) {
        throw new ConflictError("Recipient identity is already in use.");
      }
      nextRecipients.set(recipient.id, structuredClone(recipient));
      this.afterDeliveryMutation({
        operation: "commit",
        entity: "recipient",
        index,
      });
    });
    if (idempotency) {
      nextIdempotency.set(idempotency.key_hash, {
        ...structuredClone(idempotency),
        email_id: email.id,
      });
      this.afterDeliveryMutation({
        operation: "commit",
        entity: "idempotency",
      });
    }
    nextOutbox.set(outbox.id, structuredClone(outbox));
    nextOutboxByMessage.set(message.id, outbox.id);
    this.afterDeliveryMutation({ operation: "commit", entity: "outbox" });

    // All staged writes become visible together. A fault before this point
    // leaves the prior maps untouched.
    this.emails = nextEmails;
    this.idempotency = nextIdempotency;
    this.deliveryMessages = nextMessages;
    this.deliveryRecipients = nextRecipients;
    this.outboxItems = nextOutbox;
    this.outboxByMessage = nextOutboxByMessage;
    this.afterDeliveryMutation({
      operation: "commit_swap",
      entity: "outbox",
    });

    return {
      email: structuredClone(email),
      message: structuredClone(message),
      recipients: structuredClone(recipients),
      outbox: structuredClone(outbox),
      ...(idempotency
        ? { idempotency: structuredClone(idempotency) }
        : {}),
      replayed: false,
    };
  }

  async getDelivery(
    messageId: string,
  ): Promise<DeliveryCommitResult | undefined> {
    return this.deliveryResult(messageId, false);
  }

  async getDeliveryLedger(
    messageId: string,
  ): Promise<DeliveryLedgerSnapshot | undefined> {
    return this.deliveryLedger(messageId);
  }

  async beginDeliveryAttempt(
    input: DeliveryAttemptRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const attempt = deliveryAttemptRecordSchema.parse(input);
    const snapshot = this.deliveryLedger(attempt.message_id);
    if (!snapshot) {
      return undefined;
    }
    const existing = snapshot.attempts.find(
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
    const plan = planAttemptStart(snapshot, attempt);
    this.commitLedgerPlan(plan, { attempt });
    return this.deliveryLedgerResult(
      attempt.message_id,
      false,
      plan.changed_recipient_ids,
      { attempt },
    );
  }

  async completeDeliveryAttempt(
    input: AttemptCompletion,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const snapshot = this.deliveryLedger(input.message_id);
    if (!snapshot) {
      return undefined;
    }
    const existing = snapshot.attempts.find(
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
    const plan = planAttemptCompletion(snapshot, input);
    this.commitLedgerPlan(plan, { attempt: plan.attempt });
    return this.deliveryLedgerResult(
      input.message_id,
      false,
      plan.changed_recipient_ids,
      { attempt: plan.attempt },
    );
  }

  async appendProviderEvent(
    input: ProviderEventRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const event = providerEventRecordSchema.parse(input);
    const existing = this.providerEvents.get(event.id);
    if (existing) {
      if (!isEquivalentProviderEventReplay(existing, event)) {
        throw new ConflictError(
          "Provider event identity is already used by a different normalized event.",
        );
      }
      return this.deliveryLedgerResult(
        existing.message_id,
        true,
        [],
        { event: existing },
      );
    }
    const snapshot = this.deliveryLedger(event.message_id);
    if (!snapshot) {
      return undefined;
    }
    const plan = planProviderEvent(snapshot, event);
    this.commitLedgerPlan(plan, { event });
    return this.deliveryLedgerResult(
      event.message_id,
      false,
      plan.changed_recipient_ids,
      { event },
    );
  }

  async applyLocalDeliveryState(
    messageId: string,
    status: "canceled" | "suppressed",
    updatedAt: string,
  ): Promise<DeliveryLedgerMutationResult | undefined> {
    const snapshot = this.deliveryLedger(messageId);
    if (!snapshot) {
      return undefined;
    }
    const plan = planLocalRecipientState(snapshot, status, updatedAt);
    this.commitLedgerPlan(plan);
    return this.deliveryLedgerResult(
      messageId,
      false,
      plan.changed_recipient_ids,
    );
  }

  async getProviderEvent(
    id: string,
  ): Promise<ProviderEventRecord | undefined> {
    const event = this.providerEvents.get(id);
    return event ? structuredClone(event) : undefined;
  }

  async getLatestProviderEventReceivedAt(): Promise<string | undefined> {
    return [...this.providerEvents.values()]
      .map((event) => event.received_at)
      .sort((left, right) => right.localeCompare(left))[0];
  }

  async getOutboxItem(id: string): Promise<OutboxItemRecord | undefined> {
    const item = this.outboxItems.get(id);
    return item ? structuredClone(item) : undefined;
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
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error("Outbox lease limit must be a positive integer.");
    }
    if (input.limit > 1_000) {
      throw new Error("Outbox lease limit cannot exceed 1000.");
    }
    const nowEpochMilliseconds = input.now.getTime();
    const nowIso = input.now.toISOString();
    const leaseExpiresAt = new Date(
      nowEpochMilliseconds + input.lease_seconds * 1_000,
    ).toISOString();
    const due = [...this.outboxItems.values()]
      .filter(
        (item) =>
          item.dispatched_at === undefined &&
          Date.parse(item.due_at) <= nowEpochMilliseconds &&
          (item.lease_expires_at === undefined ||
            Date.parse(item.lease_expires_at) <= nowEpochMilliseconds),
      )
      .sort(
        (left, right) =>
          left.due_at.localeCompare(right.due_at) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
    const leased: OutboxItemRecord[] = [];
    for (const item of due) {
      const updated = outboxItemRecordSchema.parse({
        ...item,
        attempts: item.attempts + 1,
        lease_owner: input.owner,
        lease_expires_at: leaseExpiresAt,
        updated_at: nowIso,
      });
      this.outboxItems.set(item.id, updated);
      leased.push(structuredClone(updated));
      this.afterDeliveryMutation({ operation: "lease", entity: "outbox" });
    }
    return leased;
  }

  async acknowledgeOutbox(
    id: string,
    owner: string,
    now: Date,
  ): Promise<boolean> {
    const item = this.outboxItems.get(id);
    if (
      !item ||
      item.dispatched_at !== undefined ||
      item.lease_owner !== owner
    ) {
      return false;
    }
    const updated = outboxItemRecordSchema.parse({
      ...item,
      lease_owner: undefined,
      lease_expires_at: undefined,
      dispatched_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    this.outboxItems.set(id, updated);
    this.afterDeliveryMutation({
      operation: "acknowledge",
      entity: "outbox",
    });
    return true;
  }

  async recordOutboxFailure(
    id: string,
    owner: string,
    category: DeliveryDiagnosticCategory,
    now: Date,
  ): Promise<boolean> {
    const item = this.outboxItems.get(id);
    if (
      !item ||
      item.dispatched_at !== undefined ||
      item.lease_owner !== owner
    ) {
      return false;
    }
    const updated = outboxItemRecordSchema.parse({
      ...item,
      lease_owner: undefined,
      lease_expires_at: undefined,
      last_diagnostic_category:
        deliveryDiagnosticCategorySchema.parse(category),
      updated_at: now.toISOString(),
    });
    this.outboxItems.set(id, updated);
    this.outboxPublishFailures += 1;
    this.afterDeliveryMutation({ operation: "failure", entity: "outbox" });
    return true;
  }

  async getOutboxMetrics(now: Date): Promise<OutboxMetrics> {
    const nowEpochMilliseconds = now.getTime();
    let due = 0;
    let leased = 0;
    let stuckLeases = 0;
    let undispatched = 0;
    let oldestDueAt: number | undefined;
    for (const item of this.outboxItems.values()) {
      if (item.dispatched_at !== undefined) {
        continue;
      }
      undispatched += 1;
      const dueAt = Date.parse(item.due_at);
      if (dueAt > nowEpochMilliseconds) {
        continue;
      }
      oldestDueAt =
        oldestDueAt === undefined ? dueAt : Math.min(oldestDueAt, dueAt);
      const activeLease =
        item.lease_expires_at !== undefined &&
        Date.parse(item.lease_expires_at) > nowEpochMilliseconds;
      if (activeLease) {
        leased += 1;
      } else {
        due += 1;
        if (item.lease_expires_at !== undefined) {
          stuckLeases += 1;
        }
      }
    }
    return {
      due,
      leased,
      stuck_leases: stuckLeases,
      undispatched,
      oldest_due_age_seconds:
        oldestDueAt === undefined
          ? 0
          : Math.max(
              0,
              Math.floor((nowEpochMilliseconds - oldestDueAt) / 1_000),
            ),
      publish_failures_total: this.outboxPublishFailures,
      truncated: false,
    };
  }

  private deliveryResult(
    messageId: string,
    replayed: boolean,
  ): DeliveryCommitResult | undefined {
    const email = this.emails.get(messageId);
    const message = this.deliveryMessages.get(messageId);
    const outboxId = this.outboxByMessage.get(messageId);
    const outbox = outboxId ? this.outboxItems.get(outboxId) : undefined;
    if (!email || !message || !outbox) {
      return undefined;
    }
    const recipients = message.recipient_ids.map((id) =>
      this.deliveryRecipients.get(id),
    );
    if (recipients.some((recipient) => recipient === undefined)) {
      return undefined;
    }
    const claimEntry = [...this.idempotency.values()].find(
      (entry) => entry.email_id === messageId,
    );
    const idempotency = claimEntry
      ? {
          key_hash: claimEntry.key_hash,
          request_hash: claimEntry.request_hash,
          expires_at: claimEntry.expires_at,
        }
      : undefined;
    return {
      email: structuredClone(email),
      message: structuredClone(message),
      recipients: structuredClone(recipients as RecipientRecord[]),
      outbox: structuredClone(outbox),
      ...(idempotency ? { idempotency } : {}),
      replayed,
    };
  }

  private deliveryLedger(
    messageId: string,
  ): DeliveryLedgerSnapshot | undefined {
    const email = this.emails.get(messageId);
    const message = this.deliveryMessages.get(messageId);
    if (!email || !message) {
      return undefined;
    }
    const recipients = message.recipient_ids.map((id) =>
      this.deliveryRecipients.get(id),
    );
    if (recipients.some((recipient) => recipient === undefined)) {
      return undefined;
    }
    const attempts = [...this.deliveryAttempts.values()]
      .filter((attempt) => attempt.message_id === messageId)
      .sort(
        (left, right) =>
          left.sequence - right.sequence || left.id.localeCompare(right.id),
      );
    const events = [...this.providerEvents.values()]
      .filter((event) => event.message_id === messageId)
      .sort(
        (left, right) =>
          left.received_at.localeCompare(right.received_at) ||
          left.id.localeCompare(right.id),
      );
    return structuredClone({
      email,
      message,
      recipients: recipients as RecipientRecord[],
      attempts,
      events,
    });
  }

  private commitLedgerPlan(
    plan: DeliveryLedgerPlan,
    addition: {
      attempt?: DeliveryAttemptRecord | undefined;
      event?: ProviderEventRecord | undefined;
    } = {},
  ): void {
    const nextEmails = new Map(this.emails);
    const nextMessages = new Map(this.deliveryMessages);
    const nextRecipients = new Map(this.deliveryRecipients);
    const nextAttempts = new Map(this.deliveryAttempts);
    const nextEvents = new Map(this.providerEvents);

    nextEmails.set(plan.email.id, structuredClone(plan.email));
    this.afterDeliveryMutation({ operation: "ledger", entity: "email" });
    nextMessages.set(plan.message.id, structuredClone(plan.message));
    this.afterDeliveryMutation({ operation: "ledger", entity: "message" });
    plan.recipients.forEach((recipient, index) => {
      nextRecipients.set(recipient.id, structuredClone(recipient));
      this.afterDeliveryMutation({
        operation: "ledger",
        entity: "recipient",
        index,
      });
    });
    if (addition.attempt) {
      nextAttempts.set(
        addition.attempt.id,
        structuredClone(addition.attempt),
      );
      this.afterDeliveryMutation({ operation: "ledger", entity: "attempt" });
    }
    if (addition.event) {
      nextEvents.set(addition.event.id, structuredClone(addition.event));
      this.afterDeliveryMutation({
        operation: "ledger",
        entity: "provider_event",
      });
    }

    this.emails = nextEmails;
    this.deliveryMessages = nextMessages;
    this.deliveryRecipients = nextRecipients;
    this.deliveryAttempts = nextAttempts;
    this.providerEvents = nextEvents;
  }

  private deliveryLedgerResult(
    messageId: string,
    replayed: boolean,
    changedRecipientIds: string[],
    addition: {
      attempt?: DeliveryAttemptRecord | undefined;
      event?: ProviderEventRecord | undefined;
    } = {},
  ): DeliveryLedgerMutationResult | undefined {
    const snapshot = this.deliveryLedger(messageId);
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

  private afterDeliveryMutation(mutation: MemoryDeliveryMutation): void {
    this.options.afterDeliveryMutation?.(mutation);
  }
}
