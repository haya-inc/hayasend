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
import type { DeliveryOutboxStore } from "./delivery-outbox-store.js";

export interface Store extends DeliveryOutboxStore {
  createEmail(
    record: EmailRecord,
    idempotency?: IdempotencyClaim,
  ): Promise<CreateEmailResult>;
  getEmail(id: string): Promise<EmailRecord | undefined>;
  claimEmailForSend(
    id: string,
    attempt: number,
    now: Date,
  ): Promise<EmailRecord | undefined>;
  updateEmail(
    id: string,
    updates: Partial<EmailRecord>,
    fromStatuses?: EmailStatus[],
  ): Promise<EmailRecord | undefined>;
  rescheduleEmailAndOutbox(
    id: string,
    scheduledAt: string,
    now: Date,
  ): Promise<EmailRecord | undefined>;
  listEmails(limit: number, cursor?: string): Promise<Page<EmailRecord>>;

  createTemplate(record: TemplateRecord): Promise<void>;
  getTemplate(identifier: string): Promise<TemplateRecord | undefined>;
  getPublishedTemplate(
    identifier: string,
  ): Promise<TemplateRecord | undefined>;
  replaceTemplate(
    record: TemplateRecord,
    previousAlias: string | undefined,
    expectedRevision: number,
  ): Promise<boolean>;
  publishTemplate(
    record: TemplateRecord,
    publication: TemplatePublicationRecord,
    previousPublishedAlias: string | undefined,
    expectedRevision: number,
    historyLimit: number,
  ): Promise<boolean>;
  getTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<TemplatePublicationRecord | undefined>;
  listTemplateVersions(
    templateId: string,
    limit: number,
    cursor: TemplatePublicationRecord | undefined,
    nowEpochSeconds: number,
  ): Promise<Page<TemplatePublicationRecord>>;
  deleteTemplate(
    record: TemplateRecord,
    expectedRevision: number,
  ): Promise<boolean>;
  listTemplates(
    limit: number,
    cursor?: string,
    direction?: "after" | "before",
  ): Promise<Page<TemplateRecord>>;

  putAttachmentUpload(record: AttachmentUploadRecord): Promise<void>;
  getAttachmentUpload(id: string): Promise<AttachmentUploadRecord | undefined>;

  claimReceivedEmail(
    id: string,
    now: number,
    leaseUntil: number,
    expiresAt: number,
  ): Promise<boolean>;
  releaseReceivedEmailClaim(id: string, leaseUntil: number): Promise<void>;
  createReceivedEmail(record: ReceivedEmailRecord): Promise<boolean>;
  getReceivedEmail(id: string): Promise<ReceivedEmailRecord | undefined>;
  updateReceivedEmail(
    id: string,
    updates: Partial<ReceivedEmailRecord>,
  ): Promise<ReceivedEmailRecord | undefined>;
  listReceivedEmails(
    limit: number,
    cursor?: string,
  ): Promise<Page<ReceivedEmailRecord>>;

  createDomain(record: DomainRecord): Promise<void>;
  getDomain(id: string): Promise<DomainRecord | undefined>;
  updateDomain(
    id: string,
    updates: Partial<DomainRecord>,
  ): Promise<DomainRecord | undefined>;
  deleteDomain(id: string): Promise<boolean>;
  listDomains(limit: number, cursor?: string): Promise<Page<DomainRecord>>;

  createWebhook(record: WebhookEndpoint): Promise<void>;
  getWebhook(id: string): Promise<WebhookEndpoint | undefined>;
  updateWebhook(
    id: string,
    updates: Partial<Pick<WebhookEndpoint, "endpoint" | "events" | "status">>,
  ): Promise<WebhookEndpoint | undefined>;
  deleteWebhook(id: string): Promise<boolean>;
  listWebhooks(limit: number, cursor?: string): Promise<Page<WebhookEndpoint>>;
  createWebhookDelivery(record: WebhookDeliveryRecord): Promise<boolean>;
  getWebhookDelivery(id: string): Promise<WebhookDeliveryRecord | undefined>;
  updateWebhookDelivery(
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
  ): Promise<WebhookDeliveryRecord | undefined>;
  listWebhookDeliveries(
    webhookId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookDeliveryRecord>>;

  createApiKey(record: ApiKeyRecord): Promise<void>;
  getApiKey(id: string): Promise<ApiKeyRecord | undefined>;
  updateApiKey(
    id: string,
    updates: Partial<ApiKeyRecord>,
  ): Promise<ApiKeyRecord | undefined>;
  listApiKeys(limit: number, cursor?: string): Promise<Page<ApiKeyRecord>>;

  putSuppression(record: SuppressionRecord): Promise<void>;
  getSuppression(emailHash: string): Promise<SuppressionRecord | undefined>;
  deleteSuppression(emailHash: string): Promise<boolean>;
  listSuppressions(
    limit: number,
    cursor?: string,
  ): Promise<Page<SuppressionRecord>>;
}
