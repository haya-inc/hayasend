import PostalMime from "postal-mime";
import type { Address, Attachment, Email, Mailbox } from "postal-mime";
import {
  base64ToBytes,
  bytesToBase64,
  utf8Bytes,
} from "../core/bytes.js";
import { sha256 } from "../core/crypto.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type {
  InboundEmailEvent,
  Page,
  PublicReceivedEmailAttachment,
  ReceivedEmailContent,
  ReceivedEmailRecord,
} from "../core/types.js";
import type { InboundStorage } from "../ports/inbound-storage.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { Store } from "../ports/store.js";
import type { WebhookService } from "./webhook-service.js";

const MAX_ATTACHMENTS = 50;
const MAX_STRUCTURED_BODY_BYTES = 5 * 1024 * 1024;
const MAX_DATA_URI_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_VALUE_BYTES = 64 * 1024;
const PROCESSING_LEASE_SECONDS = 150;

function stableId(prefix: string, value: string) {
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function safeText(value: string, maximum = 998) {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maximum);
}

function formatMailbox(mailbox: Mailbox) {
  const address = safeText(mailbox.address, 998);
  const name = safeText(mailbox.name, 998);
  return name ? `${name} <${address}>` : address;
}

function flattenAddress(address: Address): Mailbox[] {
  return "group" in address ? (address.group ?? []) : [address];
}

function formatAddresses(addresses: Address[] | undefined) {
  return unique(
    (addresses ?? [])
      .flatMap(flattenAddress)
      .map(formatMailbox)
      .filter(Boolean),
  );
}

function addressOnly(value: string) {
  const bracketed = value.match(/<([^<>]+)>$/);
  return (bracketed?.[1] ?? value).trim().toLowerCase();
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function attachmentBytes(attachment: Attachment) {
  if (typeof attachment.content === "string") {
    return attachment.encoding === "base64"
      ? base64ToBytes(attachment.content)
      : utf8Bytes(attachment.content);
  }
  return attachment.content instanceof ArrayBuffer
    ? new Uint8Array(attachment.content)
    : Uint8Array.from(attachment.content);
}

function truncateUtf8(value: string | undefined, limit: number) {
  if (value === undefined) {
    return { value: null, truncated: false };
  }
  const encoded = utf8Bytes(value);
  if (encoded.byteLength <= limit) {
    return { value, truncated: false };
  }
  return {
    value: `${new TextDecoder().decode(encoded.subarray(0, limit))}\n[HayaSend: content truncated; use raw.download_url for the complete message]`,
    truncated: true,
  };
}

function structuredContent(email: Email): {
  content: ReceivedEmailContent;
  truncated: boolean;
} {
  const perBodyLimit = Math.floor(MAX_STRUCTURED_BODY_BYTES / 2);
  const html = truncateUtf8(email.html, perBodyLimit);
  const text = truncateUtf8(email.text, perBodyLimit);
  let truncated = html.truncated || text.truncated;
  const headers = Object.create(null) as Record<string, string>;
  for (const header of email.headers) {
    if (["__proto__", "constructor", "prototype"].includes(header.key)) {
      continue;
    }
    const value = truncateUtf8(header.value, MAX_HEADER_VALUE_BYTES);
    truncated ||= value.truncated;
    headers[header.key] = headers[header.key]
      ? `${headers[header.key]}, ${value.value ?? ""}`
      : (value.value ?? "");
  }
  return {
    content: {
      html: html.value,
      text: text.value,
      headers,
    },
    truncated,
  };
}

function publicAttachment(
  attachment: ReceivedEmailRecord["attachments"][number],
): PublicReceivedEmailAttachment {
  const { object_key: _objectKey, ...result } = attachment;
  return result;
}

function publicMetadata(record: ReceivedEmailRecord) {
  return {
    object: "email" as const,
    id: record.id,
    to: record.to,
    received_for: record.received_for,
    from: record.from,
    created_at: record.created_at,
    subject: record.subject,
    bcc: record.bcc,
    cc: record.cc,
    reply_to: record.reply_to,
    message_id: record.message_id,
    attachments: record.attachments.map(publicAttachment),
    ...(record.content_truncated ? { content_truncated: true } : {}),
  };
}

function validProviderMessageId(value: string) {
  return (
    value.length >= 1 &&
    value.length <= 512 &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function normalizeContentId(value: string) {
  const trimmed = value.trim();
  const withoutBrackets =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
  try {
    return decodeURIComponent(withoutBrackets).toLowerCase();
  } catch {
    return withoutBrackets.toLowerCase();
  }
}

function safeMimeType(value: string) {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
    ? value
    : "application/octet-stream";
}

export class ReceivedEmailService {
  constructor(
    private readonly store: Store,
    private readonly storage: InboundStorage,
    private readonly queue: JobQueue,
    private readonly webhooks: WebhookService,
    private readonly options: {
      rawPrefix: string;
      retentionDays: number;
      maxMessageBytes: number;
    },
  ) {}

  async ingest(
    event: InboundEmailEvent,
  ): Promise<ReceivedEmailRecord | undefined> {
    if (!validProviderMessageId(event.provider_message_id)) {
      throw new ValidationError("Invalid inbound provider message ID.");
    }
    const id = stableId("recv", event.provider_message_id);
    const existing = await this.store.getReceivedEmail(id);
    if (existing) {
      return this.ensureWebhookQueued(existing);
    }

    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = now + this.options.retentionDays * 24 * 60 * 60;
    const leaseUntil = now + PROCESSING_LEASE_SECONDS;
    const claimed = await this.store.claimReceivedEmail(
      id,
      now,
      leaseUntil,
      expiresAt,
    );
    if (!claimed) {
      const completed = await this.store.getReceivedEmail(id);
      if (completed) {
        return this.ensureWebhookQueued(completed);
      }
      throw new Error(
        "Inbound email processing is already leased; retry the event.",
      );
    }

    try {
      const rawObjectKey = `${this.options.rawPrefix}${event.provider_message_id}`;
      const raw = await this.storage.readRaw(rawObjectKey);
      if (raw.byteLength < 1 || raw.byteLength > this.options.maxMessageBytes) {
        throw new ValidationError(
          `Inbound message size must be between 1 and ${this.options.maxMessageBytes} bytes.`,
        );
      }
      const parsed = await PostalMime.parse(raw, {
        attachmentEncoding: "arraybuffer",
        maxHeadersSize: 1024 * 1024,
        maxNestingDepth: 32,
      });
      if (parsed.attachments.length > MAX_ATTACHMENTS) {
        throw new ValidationError(
          `Inbound messages may contain at most ${MAX_ATTACHMENTS} attachments.`,
        );
      }

      const receivedAttachments: ReceivedEmailRecord["attachments"] = [];
      for (const [index, attachment] of parsed.attachments.entries()) {
        const filename =
          safeText(attachment.filename ?? `attachment-${index + 1}`, 255) ||
          `attachment-${index + 1}`;
      const attachmentId = stableId(
          "att",
          `${id}:${index}:${filename}:${attachment.contentId ?? ""}`,
      );
      const objectKey = `inbound/attachments/${id}/${attachmentId}`;
      const content = attachmentBytes(attachment);
      const contentType = safeMimeType(
        attachment.mimeType || "application/octet-stream",
      );
      await this.storage.writeAttachment(
        objectKey,
        content,
        contentType,
      );
        receivedAttachments.push({
          id: attachmentId,
          filename,
          size: content.byteLength,
          content_type: contentType,
          content_disposition: attachment.disposition,
          content_id: attachment.contentId
            ? safeText(attachment.contentId, 998)
            : null,
          object_key: objectKey,
        });
      }

      const structured = structuredContent(parsed);
      const contentObjectKey = `inbound/content/${id}.json`;
      await this.storage.writeContent(contentObjectKey, structured.content);

      const to = formatAddresses(parsed.to);
      const cc = formatAddresses(parsed.cc);
      const parsedBcc = formatAddresses(parsed.bcc);
      const visibleRecipients = new Set([...to, ...cc].map(addressOnly));
      const envelopeBcc = event.destinations.filter(
        (destination) => !visibleRecipients.has(addressOnly(destination)),
      );
      const createdAt = Number.isNaN(Date.parse(event.timestamp))
        ? new Date().toISOString()
        : new Date(event.timestamp).toISOString();
      const record: ReceivedEmailRecord = {
        id,
        provider_message_id: event.provider_message_id,
        message_id:
          safeText(parsed.messageId ?? event.provider_message_id, 998) ||
          event.provider_message_id,
        from:
          formatAddresses(parsed.from ? [parsed.from] : [])[0] ??
          safeText(event.source, 998),
        to: to.length > 0 ? to : unique(event.destinations),
        received_for: unique(event.destinations),
        bcc: unique([...parsedBcc, ...envelopeBcc]),
        cc,
        reply_to: formatAddresses(parsed.replyTo),
        subject: safeText(parsed.subject ?? "", 998),
        created_at: createdAt,
        raw_object_key: rawObjectKey,
        content_object_key: contentObjectKey,
        attachments: receivedAttachments,
        content_truncated: structured.truncated,
        expires_at: new Date(expiresAt * 1_000).toISOString(),
      };
      const created = await this.store.createReceivedEmail(record);
      const persisted = created
        ? record
        : await this.store.getReceivedEmail(id);
      return persisted ? this.ensureWebhookQueued(persisted) : undefined;
    } finally {
      await this.store
        .releaseReceivedEmailClaim(id, leaseUntil)
        .catch(() => undefined);
    }
  }

  async publishWebhook(id: string): Promise<void> {
    const record = await this.getRecord(id);
    const metadata = publicMetadata(record);
    await this.webhooks.publishData("email.received", {
      created_at: record.created_at,
      email_id: record.id,
      from: record.from,
      to: record.to,
      received_for: record.received_for,
      subject: record.subject,
      bcc: record.bcc,
      cc: record.cc,
      message_id: record.message_id,
      attachments: metadata.attachments.map(
        ({ size: _size, ...attachment }) => attachment,
      ),
    });
  }

  async list(
    limit: number,
    cursor?: string,
  ): Promise<Page<ReturnType<typeof publicMetadata>>> {
    const page = await this.store.listReceivedEmails(limit, cursor);
    const now = Date.now();
    return {
      ...page,
      data: page.data
        .filter((record) => Date.parse(record.expires_at) > now)
        .map(publicMetadata),
    };
  }

  async get(id: string, requestedHtmlFormat: "data_uri" | "cid" = "data_uri") {
    const record = await this.getRecord(id);
    const [content, raw] = await Promise.all([
      this.storage.readContent(record.content_object_key),
      this.storage.createDownloadTarget(
        record.raw_object_key,
        `${record.id}.eml`,
        "message/rfc822",
      ),
    ]);
    const rendered = await this.renderHtml(
      content.html,
      record,
      requestedHtmlFormat,
    );
    return {
      ...publicMetadata(record),
      ...content,
      html: rendered.html,
      html_format: rendered.format,
      raw,
    };
  }

  async listAttachments(id: string) {
    const record = await this.getRecord(id);
    return {
      object: "list" as const,
      data: await Promise.all(
        record.attachments.map((attachment) =>
          this.downloadableAttachment(attachment),
        ),
      ),
      has_more: false,
    };
  }

  async getAttachment(id: string, attachmentId: string) {
    const record = await this.getRecord(id);
    const attachment = record.attachments.find(
      (candidate) => candidate.id === attachmentId,
    );
    if (!attachment) {
      throw new NotFoundError("Received email attachment");
    }
    return {
      object: "attachment" as const,
      ...(await this.downloadableAttachment(attachment)),
    };
  }

  private async ensureWebhookQueued(record: ReceivedEmailRecord) {
    if (record.webhook_queued_at) {
      return record;
    }
    await this.queue.enqueue({
      type: "publish_received_email",
      email_id: record.id,
    });
    const updated = await this.store.updateReceivedEmail(record.id, {
      webhook_queued_at: new Date().toISOString(),
    });
    return updated ?? record;
  }

  private async getRecord(id: string) {
    const record = await this.store.getReceivedEmail(id);
    if (!record || Date.parse(record.expires_at) <= Date.now()) {
      throw new NotFoundError("Received email");
    }
    return record;
  }

  private async downloadableAttachment(
    attachment: ReceivedEmailRecord["attachments"][number],
  ) {
    const target = await this.storage.createDownloadTarget(
      attachment.object_key,
      attachment.filename,
      attachment.content_type,
    );
    return {
      ...publicAttachment(attachment),
      content_disposition:
        attachment.content_disposition ?? ("attachment" as const),
      ...target,
    };
  }

  private async renderHtml(
    html: string | null,
    record: ReceivedEmailRecord,
    requestedFormat: "data_uri" | "cid",
  ): Promise<{ html: string | null; format: "data_uri" | "cid" }> {
    if (!html || requestedFormat === "cid") {
      return { html, format: "cid" };
    }

    const attachmentsByContentId = new Map(
      record.attachments
        .filter((attachment) => attachment.content_id)
        .map((attachment) => [
          normalizeContentId(attachment.content_id ?? ""),
          attachment,
        ]),
    );
    const referencedIds = unique(
      [...html.matchAll(/cid:([^"'()<>\s]+)/gi)].map((match) =>
        normalizeContentId(match[1] ?? ""),
      ),
    );
    if (referencedIds.length === 0) {
      return { html, format: "data_uri" };
    }
    const referencedAttachments = referencedIds.map((contentId) =>
      attachmentsByContentId.get(contentId),
    );
    if (
      referencedAttachments.some((attachment) => !attachment) ||
      referencedAttachments.reduce(
        (sum, attachment) => sum + (attachment?.size ?? 0),
        0,
      ) > MAX_DATA_URI_ATTACHMENT_BYTES
    ) {
      return { html, format: "cid" };
    }

    const dataUris = new Map<string, string>();
    for (const attachment of referencedAttachments) {
      if (!attachment) {
        continue;
      }
      const bytes = await this.storage.readAttachment(attachment.object_key);
      dataUris.set(
        normalizeContentId(attachment.content_id ?? ""),
        `data:${safeMimeType(attachment.content_type)};base64,${bytesToBase64(bytes)}`,
      );
    }
    return {
      html: html.replace(
        /cid:([^"'()<>\s]+)/gi,
        (original, contentId: string) =>
          dataUris.get(normalizeContentId(contentId)) ?? original,
      ),
      format: "data_uri",
    };
  }
}
