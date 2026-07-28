import type {
  EmailMessage,
  EmailSendResponse,
} from "@azure/communication-email";
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
import { normalizeMailbox } from "../../services/suppression-service.js";

export const ACS_MAX_COMBINED_RECIPIENTS = 50;
export const ACS_MAX_ATTACHMENTS = 20;
export const ACS_MAX_SERIALIZED_REQUEST_BYTES = 10_000_000;
export const ACS_MAX_DECODED_ATTACHMENT_BYTES = 7_500_000;

export interface AcsEmailClient {
  beginSend(message: EmailMessage): Promise<{
    pollUntilDone(): Promise<EmailSendResponse>;
  }>;
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
}

function statusCode(error: unknown): number | undefined {
  const candidate = errorRecord(error);
  const response = errorRecord(candidate?.response);
  return typeof candidate?.statusCode === "number"
    ? candidate.statusCode
    : typeof response?.status === "number"
      ? response.status
      : undefined;
}

function providerCode(error: unknown): string | undefined {
  const candidate = errorRecord(error);
  const raw =
    typeof candidate?.code === "string"
      ? candidate.code
      : typeof candidate?.name === "string"
        ? candidate.name
        : undefined;
  return raw && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(raw)
    ? raw
    : undefined;
}

function classifyAcsEmailError(error: unknown): {
  category:
    | "provider_error"
    | "provider_rejected"
    | "provider_throttled"
    | "provider_unavailable";
  status: number;
} {
  const status = statusCode(error);
  if (status === 429) {
    return { category: "provider_throttled", status: 429 };
  }
  if (status === 408 || (status !== undefined && status >= 500)) {
    return { category: "provider_unavailable", status: 503 };
  }
  if (status !== undefined && status >= 400) {
    return { category: "provider_rejected", status: 422 };
  }
  return { category: "provider_error", status: 503 };
}

export class AcsEmailError extends AppError {
  readonly provider_code: string | undefined;

  constructor(error: unknown) {
    const classification = classifyAcsEmailError(error);
    super(
      classification.status,
      classification.category,
      `Azure Communication Services Email request failed (${classification.category}).`,
    );
    this.provider_code = providerCode(error);
  }
}

function emailAddress(value: string): {
  address: string;
  displayName?: string;
} {
  const match = /^\s*"?([^"<>\r\n]*)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(
    value,
  );
  const displayName = match?.[1]?.trim();
  return {
    address: normalizeMailbox(value),
    ...(displayName ? { displayName } : {}),
  };
}

function buildAcsEmailMessageShape(
  email: EmailRecord,
  requireMaterializedAttachments: boolean,
): EmailMessage {
  const recipients = {
    to: email.to.map(emailAddress),
    ...(email.cc ? { cc: email.cc.map(emailAddress) } : {}),
    ...(email.bcc ? { bcc: email.bcc.map(emailAddress) } : {}),
  };
  const content = email.html
    ? {
        subject: email.subject,
        html: email.html,
        ...(email.text !== undefined ? { plainText: email.text } : {}),
      }
    : {
        subject: email.subject,
        plainText: email.text ?? "",
      };
  return {
    senderAddress: normalizeMailbox(email.from),
    content,
    recipients,
    ...(email.headers ? { headers: email.headers } : {}),
    ...(email.reply_to
      ? { replyTo: email.reply_to.map(emailAddress) }
      : {}),
    ...(email.attachments
      ? {
          attachments: email.attachments.map((attachment) => {
            if (requireMaterializedAttachments && !attachment.content) {
              throw new ValidationError(
                `Attachment ${attachment.filename} was not materialized.`,
              );
            }
            return {
              name: attachment.filename,
              contentType:
                attachment.content_type ?? "application/octet-stream",
              contentInBase64: requireMaterializedAttachments
                ? attachment.content!
                : "",
              ...(attachment.content_disposition === "inline" &&
              attachment.content_id
                ? { contentId: attachment.content_id }
                : {}),
            };
          }),
        }
      : {}),
  };
}

export function buildAcsEmailMessage(email: EmailRecord): EmailMessage {
  return buildAcsEmailMessageShape(email, true);
}

function attachmentBase64Length(
  attachment: NonNullable<EmailRecord["attachments"]>[number],
): number {
  if (attachment.content) {
    return utf8ByteLength(attachment.content);
  }
  if (attachment.size_bytes === undefined) {
    throw new ValidationError(
      `Attachment ${attachment.filename} has no verifiable size.`,
    );
  }
  return 4 * Math.ceil(attachment.size_bytes / 3);
}

function attachmentDecodedLength(
  attachment: NonNullable<EmailRecord["attachments"]>[number],
): number {
  if (attachment.size_bytes !== undefined) {
    return attachment.size_bytes;
  }
  if (attachment.content) {
    return base64ToBytes(attachment.content).byteLength;
  }
  throw new ValidationError(
    `Attachment ${attachment.filename} has no verifiable size.`,
  );
}

export function estimateAcsSerializedRequestBytes(
  email: EmailRecord,
): number {
  const shape = buildAcsEmailMessageShape(email, false);
  return (
    utf8ByteLength(JSON.stringify(shape)) +
    (email.attachments ?? []).reduce(
      (total, attachment) => total + attachmentBase64Length(attachment),
      0,
    )
  );
}

export function assertAcsEmailRecordPreflight(email: EmailRecord): void {
  const recipientCount =
    email.to.length + (email.cc?.length ?? 0) + (email.bcc?.length ?? 0);
  if (
    recipientCount < 1 ||
    recipientCount > ACS_MAX_COMBINED_RECIPIENTS
  ) {
    throw new ValidationError(
      `Azure Communication Services Email requires between 1 and ${ACS_MAX_COMBINED_RECIPIENTS} combined recipients.`,
    );
  }
  if ((email.attachments?.length ?? 0) > ACS_MAX_ATTACHMENTS) {
    throw new ValidationError(
      `Azure Communication Services Email supports at most ${ACS_MAX_ATTACHMENTS} attachments.`,
    );
  }
  for (const attachment of email.attachments ?? []) {
    if (
      attachment.content_disposition === "inline" &&
      !attachment.content_id
    ) {
      throw new ValidationError(
        "Azure Communication Services Email inline attachments require a content ID.",
      );
    }
  }
  const decodedAttachmentBytes = (email.attachments ?? []).reduce(
    (total, attachment) => total + attachmentDecodedLength(attachment),
    0,
  );
  if (decodedAttachmentBytes > ACS_MAX_DECODED_ATTACHMENT_BYTES) {
    throw new ValidationError(
      `Azure Communication Services Email decoded attachments must not exceed ${ACS_MAX_DECODED_ATTACHMENT_BYTES} bytes.`,
    );
  }
  if (
    estimateAcsSerializedRequestBytes(email) >
    ACS_MAX_SERIALIZED_REQUEST_BYTES
  ) {
    throw new ValidationError(
      "Azure Communication Services Email requests must not exceed 10 MB including base64 attachments.",
    );
  }
}

export function assertAcsEmailPreflight(email: EmailRecord): EmailMessage {
  assertAcsEmailRecordPreflight(email);
  const message = buildAcsEmailMessage(email);
  if (
    utf8ByteLength(JSON.stringify(message)) >
    ACS_MAX_SERIALIZED_REQUEST_BYTES
  ) {
    throw new ValidationError(
      "Azure Communication Services Email requests must not exceed 10 MB including base64 attachments.",
    );
  }
  return message;
}

export class AcsEmailTransport implements MailTransport {
  constructor(private readonly client: AcsEmailClient) {}

  async send(email: EmailRecord): Promise<MailTransportResult> {
    const message = assertAcsEmailPreflight(email);
    try {
      const poller = await this.client.beginSend(message);
      const result = await poller.pollUntilDone();
      if (
        result.status !== "Succeeded" ||
        !/^[\x21-\x3F\x41-\x7E]{1,512}$/.test(result.id)
      ) {
        throw new AcsEmailError({
          code: `EmailSend${result.status}`,
        });
      }
      return { provider_id: result.id };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AcsEmailError(error);
    }
  }
}
