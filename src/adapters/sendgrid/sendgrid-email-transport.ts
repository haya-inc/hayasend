import { utf8ByteLength } from "../../core/bytes.js";
import { ValidationError } from "../../core/errors.js";
import type { EmailRecord } from "../../core/types.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../../ports/mail-transport.js";
import { normalizeMailbox } from "../../services/suppression-service.js";
import type { SendGridApi } from "./sendgrid-api-client.js";

export const SENDGRID_MAX_COMBINED_RECIPIENTS = 1_000;
export const SENDGRID_MAX_ATTACHMENTS = 20;
export const SENDGRID_MAX_SERIALIZED_REQUEST_BYTES = 29_999_999;
export const SENDGRID_MAX_DECODED_ATTACHMENT_BYTES = 20_000_000;

const SENDGRID_RESERVED_HEADERS = new Set(
  [
    "bcc",
    "cc",
    "content-transfer-encoding",
    "content-type",
    "dkim-signature",
    "from",
    "message-id",
    "received",
    "reply-to",
    "subject",
    "to",
    "x-sg-eid",
    "x-sg-id",
  ].map((value) => value.toLowerCase()),
);

interface SendGridMailbox {
  email: string;
  name?: string;
}

interface SendGridMailRequest {
  personalizations: Array<{
    to: SendGridMailbox[];
    cc?: SendGridMailbox[];
    bcc?: SendGridMailbox[];
    custom_args: {
      hayasend_message_id: string;
      hayasend_provider_id: string;
    };
  }>;
  from: SendGridMailbox;
  reply_to_list?: SendGridMailbox[];
  subject: string;
  content: Array<{ type: "text/plain" | "text/html"; value: string }>;
  headers: Record<string, string>;
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
    disposition: "attachment" | "inline";
    content_id?: string;
  }>;
}

function mailbox(value: string): SendGridMailbox {
  const match = /^\s*"?([^"<>\r\n]*)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(
    value,
  );
  const name = match?.[1]?.trim();
  return {
    email: normalizeMailbox(value),
    ...(name ? { name } : {}),
  };
}

export function sendGridProviderMessageId(email: EmailRecord): string {
  const sender = normalizeMailbox(email.from);
  const domain = sender.slice(sender.lastIndexOf("@") + 1).toLowerCase();
  return `<${email.id}@${domain}>`;
}

function decodedAttachmentBytes(email: EmailRecord): number {
  return (email.attachments ?? []).reduce((total, attachment) => {
    if (attachment.size_bytes !== undefined) {
      return total + attachment.size_bytes;
    }
    if (!attachment.content) {
      throw new ValidationError(
        `Attachment ${attachment.filename} has no verifiable size.`,
      );
    }
    return total + Buffer.from(attachment.content, "base64").byteLength;
  }, 0);
}

export function buildSendGridMailRequest(
  email: EmailRecord,
): SendGridMailRequest {
  const providerId = sendGridProviderMessageId(email);
  const content: SendGridMailRequest["content"] = [];
  if (email.text !== undefined) {
    content.push({ type: "text/plain", value: email.text });
  }
  if (email.html !== undefined) {
    content.push({ type: "text/html", value: email.html });
  }
  const headers = Object.fromEntries(
    Object.entries(email.headers ?? {}).filter(
      ([name]) => !SENDGRID_RESERVED_HEADERS.has(name.toLowerCase()),
    ),
  );
  headers["Message-ID"] = providerId;
  return {
    personalizations: [
      {
        to: email.to.map(mailbox),
        ...(email.cc ? { cc: email.cc.map(mailbox) } : {}),
        ...(email.bcc ? { bcc: email.bcc.map(mailbox) } : {}),
        custom_args: {
          hayasend_message_id: email.id,
          hayasend_provider_id: providerId,
        },
      },
    ],
    from: mailbox(email.from),
    ...(email.reply_to
      ? { reply_to_list: email.reply_to.map(mailbox) }
      : {}),
    subject: email.subject,
    content,
    headers,
    ...(email.attachments
      ? {
          attachments: email.attachments.map((attachment) => {
            if (!attachment.content) {
              throw new ValidationError(
                `Attachment ${attachment.filename} was not materialized.`,
              );
            }
            return {
              content: attachment.content,
              filename: attachment.filename,
              type:
                attachment.content_type ?? "application/octet-stream",
              disposition:
                attachment.content_disposition === "inline"
                  ? "inline"
                  : "attachment",
              ...(attachment.content_id
                ? { content_id: attachment.content_id }
                : {}),
            };
          }),
        }
      : {}),
  };
}

export function assertSendGridEmailRecordPreflight(
  email: EmailRecord,
): void {
  const recipientCount =
    email.to.length + (email.cc?.length ?? 0) + (email.bcc?.length ?? 0);
  if (
    recipientCount < 1 ||
    recipientCount > SENDGRID_MAX_COMBINED_RECIPIENTS
  ) {
    throw new ValidationError(
      `SendGrid requires between 1 and ${SENDGRID_MAX_COMBINED_RECIPIENTS} combined recipients.`,
    );
  }
  if ((email.attachments?.length ?? 0) > SENDGRID_MAX_ATTACHMENTS) {
    throw new ValidationError(
      `HayaSend supports at most ${SENDGRID_MAX_ATTACHMENTS} attachments through SendGrid.`,
    );
  }
  if (
    Object.keys(email.headers ?? {}).some((name) =>
      SENDGRID_RESERVED_HEADERS.has(name.toLowerCase()),
    )
  ) {
    throw new ValidationError(
      "SendGrid reserved delivery headers cannot be overridden.",
    );
  }
  if (
    decodedAttachmentBytes(email) >
    SENDGRID_MAX_DECODED_ATTACHMENT_BYTES
  ) {
    throw new ValidationError(
      `SendGrid decoded attachments must not exceed ${SENDGRID_MAX_DECODED_ATTACHMENT_BYTES} bytes.`,
    );
  }
  const request = buildSendGridMailRequest(email);
  if (
    utf8ByteLength(JSON.stringify(request)) >
    SENDGRID_MAX_SERIALIZED_REQUEST_BYTES
  ) {
    throw new ValidationError(
      "SendGrid mail requests must remain below 30 MB.",
    );
  }
}

export class SendGridMailTransport implements MailTransport {
  constructor(private readonly client: SendGridApi) {}

  async send(email: EmailRecord): Promise<MailTransportResult> {
    assertSendGridEmailRecordPreflight(email);
    const request = buildSendGridMailRequest(email);
    await this.client.request({
      method: "POST",
      path: "/v3/mail/send",
      body: request,
      expected_statuses: [202],
    });
    return {
      provider_id: sendGridProviderMessageId(email),
    };
  }
}
