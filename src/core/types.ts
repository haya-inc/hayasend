export type EmailStatus =
  | "queued"
  | "scheduled"
  | "sending"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "failed"
  | "canceled"
  | "suppressed";

export type WebhookEventType =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.opened"
  | "email.clicked"
  | "email.bounced"
  | "email.complained"
  | "email.failed"
  | "email.scheduled"
  | "email.suppressed"
  | "email.received";

export type ApiScope =
  | "*"
  | "emails:send"
  | "emails:read"
  | "domains:read"
  | "domains:write"
  | "webhooks:read"
  | "webhooks:write"
  | "suppressions:read"
  | "suppressions:write"
  | "api_keys:read"
  | "api_keys:write";

export interface AuthenticatedPrincipal {
  id: string;
  name: string;
  scopes: ApiScope[];
  bootstrap: boolean;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: ApiScope[];
  created_at: string;
  expires_at?: string | undefined;
  revoked_at?: string | undefined;
}

export interface PublicApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  created_at: string;
  expires_at?: string | undefined;
  revoked_at?: string | undefined;
}

export type SuppressionReason = "bounce" | "complaint" | "manual";

export interface SuppressionRecord {
  id: string;
  email: string;
  reason: SuppressionReason;
  created_at: string;
  updated_at: string;
  source_email_id?: string | undefined;
  detail?: string | undefined;
}

export interface EmailTag {
  name: string;
  value: string;
}

export interface EmailAttachment {
  filename: string;
  content: string;
  content_type?: string | undefined;
  content_id?: string | undefined;
  content_disposition?: "inline" | "attachment" | undefined;
}

export interface SendEmailInput {
  from: string;
  to: string[];
  subject: string;
  html?: string | undefined;
  text?: string | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  reply_to?: string[] | undefined;
  headers?: Record<string, string> | undefined;
  tags?: EmailTag[] | undefined;
  attachments?: EmailAttachment[] | undefined;
  scheduled_at?: string | undefined;
}

export interface EmailRecord extends SendEmailInput {
  id: string;
  status: EmailStatus;
  last_event: string;
  created_at: string;
  updated_at: string;
  provider_id?: string | undefined;
  request_hash: string;
  attempts: number;
  error?: string | undefined;
  send_lease_until?: number | undefined;
  payload_ref?: string | undefined;
}

export interface IdempotencyClaim {
  key_hash: string;
  request_hash: string;
  expires_at: number;
}

export interface CreateEmailResult {
  record: EmailRecord;
  replayed: boolean;
}

export type DnsRecordStatus = "pending" | "verified" | "failed";

export interface DomainDnsRecord {
  record: "SPF" | "DKIM" | "DMARC" | "MX";
  name: string;
  type: "TXT" | "CNAME" | "MX";
  value: string;
  status: DnsRecordStatus;
  priority?: number | undefined;
}

export interface DomainRecord {
  id: string;
  name: string;
  status: "not_started" | "pending" | "verified" | "failed";
  region: string;
  created_at: string;
  updated_at: string;
  records: DomainDnsRecord[];
}

export interface DomainProviderResult {
  status: DomainRecord["status"];
  records: DomainDnsRecord[];
}

export interface WebhookEndpoint {
  id: string;
  endpoint: string;
  events: WebhookEventType[];
  signing_secret: string;
  status: "enabled" | "disabled";
  created_at: string;
}

export interface PublicWebhookEndpoint {
  id: string;
  endpoint: string;
  events: WebhookEventType[];
  status: "enabled" | "disabled";
  created_at: string;
}

export interface WebhookEvent {
  type: WebhookEventType;
  created_at: string;
  data: {
    created_at: string;
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    [key: string]: unknown;
  };
}

export type Job =
  | {
      type: "send_email";
      email_id: string;
    }
  | {
      type: "deliver_webhook";
      webhook_id: string;
      event: WebhookEvent;
    };

export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string | undefined;
}
