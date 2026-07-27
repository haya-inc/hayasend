import {
  base64ToBytes,
  utf8ByteLength,
} from "../../core/bytes.js";
import { AppError, ValidationError } from "../../core/errors.js";
import type { EmailRecord } from "../../core/types.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../../ports/mail-transport.js";
import {
  injectCloudflareFault,
  type CloudflareFaultInjector,
} from "./fault-injection.js";

export const CLOUDFLARE_MAX_RECIPIENTS = 50;
export const CLOUDFLARE_MAX_ATTACHMENTS = 20;
export const CLOUDFLARE_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const CLOUDFLARE_MAX_DECODED_ATTACHMENT_BYTES = 3_800_000;

const MIME_FIXED_OVERHEAD_BYTES = 4_096;
const MIME_ATTACHMENT_OVERHEAD_BYTES = 2_048;

type CloudflareEmailErrorCategory =
  | "invalid_data"
  | "provider_error"
  | "provider_rejected"
  | "provider_throttled"
  | "provider_unavailable";

interface CloudflareEmailBinding {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}

interface CloudflareEmailTransportOptions {
  fault_injector?: CloudflareFaultInjector | undefined;
}

interface CloudflareErrorShape {
  code?: unknown;
}

const INVALID_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

const REJECTED_CODES = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_DELIVERY_FAILED",
]);

const THROTTLED_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as CloudflareErrorShape).code;
  return typeof code === "string" ? code : undefined;
}

function classifyCloudflareEmailError(code: string | undefined): {
  category: CloudflareEmailErrorCategory;
  status: number;
} {
  if (code && INVALID_CODES.has(code)) {
    return { category: "invalid_data", status: 422 };
  }
  if (code && REJECTED_CODES.has(code)) {
    return { category: "provider_rejected", status: 422 };
  }
  if (code && THROTTLED_CODES.has(code)) {
    return { category: "provider_throttled", status: 429 };
  }
  if (code === "E_INTERNAL_SERVER_ERROR") {
    return { category: "provider_unavailable", status: 503 };
  }
  return { category: "provider_error", status: 503 };
}

export class CloudflareEmailSendingError extends AppError {
  readonly provider_code: string | undefined;

  constructor(error: unknown) {
    const code = errorCode(error);
    const { category, status } = classifyCloudflareEmailError(code);
    super(
      status,
      category,
      `Cloudflare Email Sending request failed (${category}).`,
    );
    this.provider_code = code;
  }
}

function base64EncodedMimeBytes(decodedBytes: number): number {
  const encoded = 4 * Math.ceil(decodedBytes / 3);
  return encoded + 2 * Math.ceil(encoded / 76);
}

export function estimateCloudflareMimeBytes(email: EmailRecord): number {
  const envelopeAndHeaders = utf8ByteLength(
    JSON.stringify({
      from: email.from,
      to: email.to,
      cc: email.cc ?? [],
      bcc: email.bcc ?? [],
      reply_to: email.reply_to ?? [],
      subject: email.subject,
      headers: email.headers ?? {},
    }),
  );
  const bodyBytes =
    utf8ByteLength(email.text ?? "") + utf8ByteLength(email.html ?? "");
  const attachmentBytes = (email.attachments ?? []).reduce(
    (total, attachment) => {
      const decodedBytes =
        attachment.size_bytes ??
        (attachment.content
          ? base64ToBytes(attachment.content).byteLength
          : 0);
      return (
        total +
        base64EncodedMimeBytes(decodedBytes) +
        MIME_ATTACHMENT_OVERHEAD_BYTES
      );
    },
    0,
  );
  return (
    MIME_FIXED_OVERHEAD_BYTES +
    envelopeAndHeaders +
    bodyBytes +
    attachmentBytes
  );
}

export function assertCloudflareEmailPreflight(email: EmailRecord): void {
  const recipientCount =
    email.to.length + (email.cc?.length ?? 0) + (email.bcc?.length ?? 0);
  if (
    recipientCount < 1 ||
    recipientCount > CLOUDFLARE_MAX_RECIPIENTS
  ) {
    throw new ValidationError(
      `Cloudflare Email Sending requires between 1 and ${CLOUDFLARE_MAX_RECIPIENTS} combined recipients.`,
    );
  }
  if (
    (email.attachments?.length ?? 0) > CLOUDFLARE_MAX_ATTACHMENTS
  ) {
    throw new ValidationError(
      `Cloudflare Email Sending supports at most ${CLOUDFLARE_MAX_ATTACHMENTS} attachments.`,
    );
  }
  const decodedAttachmentBytes = (email.attachments ?? []).reduce(
    (total, attachment) =>
      total +
      (attachment.size_bytes ??
        (attachment.content
          ? base64ToBytes(attachment.content).byteLength
          : 0)),
    0,
  );
  if (
    decodedAttachmentBytes >
    CLOUDFLARE_MAX_DECODED_ATTACHMENT_BYTES
  ) {
    throw new ValidationError(
      `Cloudflare Email Sending decoded attachments must not exceed ${CLOUDFLARE_MAX_DECODED_ATTACHMENT_BYTES} bytes.`,
    );
  }
  if ((email.reply_to?.length ?? 0) > 1) {
    throw new ValidationError(
      "Cloudflare Email Sending supports at most one reply-to address.",
    );
  }
  for (const attachment of email.attachments ?? []) {
    if (
      attachment.content_disposition === "inline" &&
      !attachment.content_id
    ) {
      throw new ValidationError(
        "Cloudflare inline attachments require a content ID.",
      );
    }
  }
  if (estimateCloudflareMimeBytes(email) > CLOUDFLARE_MAX_MESSAGE_BYTES) {
    throw new ValidationError(
      "Cloudflare Email Sending messages must not exceed 5 MiB including attachments.",
    );
  }
}

function messageBuilder(email: EmailRecord): EmailMessageBuilder {
  assertCloudflareEmailPreflight(email);
  return {
    from: email.from,
    to: email.to,
    ...(email.cc ? { cc: email.cc } : {}),
    ...(email.bcc ? { bcc: email.bcc } : {}),
    subject: email.subject,
    ...(email.text !== undefined ? { text: email.text } : {}),
    ...(email.html !== undefined ? { html: email.html } : {}),
    ...(email.reply_to?.[0] ? { replyTo: email.reply_to[0] } : {}),
    ...(email.headers ? { headers: email.headers } : {}),
    ...(email.attachments
      ? {
          attachments: email.attachments.map((attachment) => {
            if (!attachment.content) {
              throw new ValidationError(
                `Attachment ${attachment.filename} was not materialized.`,
              );
            }
            if (attachment.content_disposition === "inline") {
              return {
                disposition: "inline" as const,
                contentId: attachment.content_id!,
                filename: attachment.filename,
                type:
                  attachment.content_type ?? "application/octet-stream",
                content: attachment.content,
              };
            }
            return {
              disposition: "attachment" as const,
              filename: attachment.filename,
              type:
                attachment.content_type ?? "application/octet-stream",
              content: attachment.content,
            };
          }),
        }
      : {}),
  };
}

export class CloudflareEmailSendingTransport implements MailTransport {
  constructor(
    private readonly binding: CloudflareEmailBinding,
    private readonly options: CloudflareEmailTransportOptions = {},
  ) {}

  async send(email: EmailRecord): Promise<MailTransportResult> {
    const message = messageBuilder(email);
    try {
      await injectCloudflareFault(this.options.fault_injector, {
        component: "email",
        operation: "send",
        target: email.id,
      });
      const result = await this.binding.send(message);
      return { provider_id: result.messageId };
    } catch (error) {
      if (
        error instanceof AppError ||
        (typeof error === "object" &&
          error !== null &&
          (error as { name?: unknown }).name === "validation_error")
      ) {
        throw error;
      }
      throw new CloudflareEmailSendingError(error);
    }
  }
}
