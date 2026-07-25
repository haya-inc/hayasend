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
  WebhookEndpoint,
} from "../core/types.js";

export interface Store {
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
  listEmails(limit: number, cursor?: string): Promise<Page<EmailRecord>>;

  putAttachmentUpload(record: AttachmentUploadRecord): Promise<void>;
  getAttachmentUpload(
    id: string,
  ): Promise<AttachmentUploadRecord | undefined>;

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
    updates: Partial<
      Pick<WebhookEndpoint, "endpoint" | "events" | "status">
    >,
  ): Promise<WebhookEndpoint | undefined>;
  deleteWebhook(id: string): Promise<boolean>;
  listWebhooks(
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookEndpoint>>;

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
