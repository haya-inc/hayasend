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
  | "templates:read"
  | "templates:write"
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

interface EmailAttachmentPresentation {
  content_type?: string | undefined;
  content_id?: string | undefined;
  content_disposition?: "inline" | "attachment" | undefined;
}

export interface InlineEmailAttachmentInput extends EmailAttachmentPresentation {
  filename: string;
  content: string;
}

export interface UploadedEmailAttachmentInput extends EmailAttachmentPresentation {
  attachment_id: string;
  filename?: string | undefined;
}

export type EmailAttachmentInput =
  InlineEmailAttachmentInput | UploadedEmailAttachmentInput;

export interface EmailAttachment extends EmailAttachmentPresentation {
  filename: string;
  content?: string | undefined;
  attachment_id?: string | undefined;
  object_key?: string | undefined;
  size_bytes?: number | undefined;
  checksum_sha256?: string | undefined;
}

export interface AttachmentUploadRecord {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  object_key: string;
  upload_token_hash: string;
  created_at: string;
  upload_expires_at: string;
  expires_at: string;
}

export interface AttachmentObjectReference {
  object_key: string;
  size_bytes: number;
  checksum_sha256: string;
}

export interface AttachmentUploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface DownloadTarget {
  download_url: string;
  expires_at: string;
}

export interface ReceivedEmailAttachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  content_disposition: "inline" | "attachment" | null;
  content_id: string | null;
  object_key: string;
}

export type PublicReceivedEmailAttachment = Omit<
  ReceivedEmailAttachment,
  "object_key"
>;

export interface ReceivedEmailContent {
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
}

export interface ReceivedEmailRecord {
  id: string;
  provider_message_id: string;
  message_id: string;
  from: string;
  to: string[];
  received_for: string[];
  bcc: string[];
  cc: string[];
  reply_to: string[];
  subject: string;
  created_at: string;
  raw_object_key: string;
  content_object_key: string;
  attachments: ReceivedEmailAttachment[];
  content_truncated: boolean;
  expires_at: string;
  webhook_queued_at?: string | undefined;
}

export interface InboundEmailEvent {
  provider_message_id: string;
  source: string;
  destinations: string[];
  timestamp: string;
  verdicts: {
    spam?: string | undefined;
    virus?: string | undefined;
    spf?: string | undefined;
    dkim?: string | undefined;
    dmarc?: string | undefined;
  };
}

export interface TemplateReference {
  id: string;
  variables?: Record<string, string | number> | undefined;
}

export interface SendEmailInput {
  from?: string | undefined;
  to: string[];
  subject?: string | undefined;
  html?: string | undefined;
  text?: string | undefined;
  template?: TemplateReference | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  reply_to?: string[] | undefined;
  headers?: Record<string, string> | undefined;
  tags?: EmailTag[] | undefined;
  attachments?: EmailAttachmentInput[] | undefined;
  scheduled_at?: string | undefined;
}

export interface EmailRecord extends Omit<
  SendEmailInput,
  "attachments" | "template" | "from" | "subject"
> {
  from: string;
  subject: string;
  attachments?: EmailAttachment[] | undefined;
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

export type TemplateVariableType = "string" | "number";

export interface TemplateVariable {
  id: string;
  key: string;
  type: TemplateVariableType;
  fallback_value: string | number | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateVersion {
  id: string;
  name: string;
  html: string;
  text?: string | undefined;
  alias?: string | undefined;
  from?: string | undefined;
  subject?: string | undefined;
  reply_to?: string[] | undefined;
  variables: TemplateVariable[];
  created_at: string;
  source_version_id?: string | undefined;
}

export type TemplatePublicationSource = "api" | "cli";

export interface TemplatePublicationActor {
  id: string;
  name: string;
}

export interface TemplatePublicationRecord {
  id: string;
  template_id: string;
  version: TemplateVersion;
  published_at: string;
  expires_at: string;
  actor: TemplatePublicationActor;
  source: TemplatePublicationSource;
  source_version_id?: string | undefined;
}

export interface TemplateRecord {
  id: string;
  created_at: string;
  updated_at: string;
  revision: number;
  draft: TemplateVersion;
  published?: TemplateVersion | undefined;
  published_at?: string | undefined;
}

export interface PublicTemplate {
  object: "template";
  id: string;
  current_version_id: string;
  alias: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  status: "draft" | "published";
  published_at: string | null;
  from: string | null;
  subject: string | null;
  reply_to: string[] | null;
  html: string;
  text: string | null;
  variables: TemplateVariable[] | null;
  has_unpublished_versions: boolean;
}

export interface RenderedTemplate {
  object: "template_render";
  template_id: string;
  version_id: string;
  from: string | null;
  subject: string | null;
  reply_to: string[] | null;
  html: string;
  text: string;
}

export type TemplateListItem = Pick<
  PublicTemplate,
  | "id"
  | "name"
  | "status"
  | "published_at"
  | "created_at"
  | "updated_at"
  | "alias"
>;

export interface TemplateVersionListItem {
  object: "template_version";
  id: string;
  template_id: string;
  published_at: string;
  expires_at: string;
  actor: TemplatePublicationActor;
  source: TemplatePublicationSource;
  source_version_id: string | null;
}

export interface PublicTemplateVersion extends TemplateVersionListItem {
  name: string;
  alias: string | null;
  from: string | null;
  subject: string | null;
  reply_to: string[] | null;
  html: string;
  text: string | null;
  variables: TemplateVariable[] | null;
}

export interface TemplateRestoreResult {
  object: "template_restore";
  template_id: string;
  source_version_id: string;
  current_version_id: string;
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

export type WebhookDeliveryStatus =
  "pending" | "delivering" | "succeeded" | "failed" | "cancelled";

export interface WebhookDeliveryRecord {
  id: string;
  webhook_id: string;
  event_type: WebhookEventType;
  event: WebhookEvent;
  status: WebhookDeliveryStatus;
  attempts: number;
  response_status?: number | undefined;
  last_error?: string | undefined;
  last_attempt_at?: string | undefined;
  replayed_from?: string | undefined;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export type WebhookDeliverySummary = Omit<WebhookDeliveryRecord, "event"> & {
  object: "webhook_delivery";
};

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
      job_id?: string | undefined;
    }
  | {
      type: "publish_received_email";
      email_id: string;
    }
  | {
      type: "deliver_webhook";
      webhook_id: string;
      delivery_id?: string | undefined;
      event: WebhookEvent;
    };

export interface Page<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string | undefined;
}
