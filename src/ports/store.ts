import type {
  CreateEmailResult,
  DomainRecord,
  EmailRecord,
  IdempotencyClaim,
  Page,
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
}
