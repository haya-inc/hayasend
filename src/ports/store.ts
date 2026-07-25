import type {
  ApiKeyRecord,
  CreateEmailResult,
  DomainRecord,
  EmailRecord,
  EmailStatus,
  IdempotencyClaim,
  Page,
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
