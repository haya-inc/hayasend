import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import type { EmailRecord } from "../core/types.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../ports/mail-transport.js";

export class SesMailTransport implements MailTransport {
  constructor(
    private readonly configurationSet?: string,
    private readonly client = new SESv2Client({}),
  ) {}

  async send(email: EmailRecord): Promise<MailTransportResult> {
    const simpleContent: NonNullable<
      NonNullable<SendEmailCommandInput["Content"]>["Simple"]
    > = {
      Subject: { Data: email.subject, Charset: "UTF-8" },
      Body: {
        ...(email.text
          ? { Text: { Data: email.text, Charset: "UTF-8" } }
          : {}),
        ...(email.html
          ? { Html: { Data: email.html, Charset: "UTF-8" } }
          : {}),
      },
      ...(email.headers
        ? {
            Headers: Object.entries(email.headers).map(([Name, Value]) => ({
              Name,
              Value,
            })),
          }
        : {}),
      ...(email.attachments
        ? {
            Attachments: email.attachments.map((attachment) => ({
              FileName: attachment.filename,
              RawContent: Buffer.from(attachment.content, "base64"),
              ContentType: attachment.content_type,
              ContentId: attachment.content_id,
              ContentDisposition:
                attachment.content_disposition === "inline"
                  ? "INLINE"
                  : "ATTACHMENT",
            })),
          }
        : {}),
    };

    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: email.from,
        Destination: {
          ToAddresses: email.to,
          ...(email.cc ? { CcAddresses: email.cc } : {}),
          ...(email.bcc ? { BccAddresses: email.bcc } : {}),
        },
        Content: { Simple: simpleContent },
        ...(email.reply_to ? { ReplyToAddresses: email.reply_to } : {}),
        ...(this.configurationSet
          ? { ConfigurationSetName: this.configurationSet }
          : {}),
        EmailTags: [
          { Name: "hayasend_id", Value: email.id },
          ...(email.tags ?? []).map((tag) => ({
            Name: tag.name,
            Value: tag.value,
          })),
        ],
      }),
    );

    return { provider_id: result.MessageId ?? email.id };
  }
}

export class ConsoleMailTransport implements MailTransport {
  async send(email: EmailRecord): Promise<MailTransportResult> {
    const providerId = `local_${email.id}`;
    console.info(
      JSON.stringify({
        level: "info",
        message: "Local email accepted",
        email_id: email.id,
        provider_id: providerId,
        from: email.from,
        to: email.to,
        subject: email.subject,
      }),
    );
    return { provider_id: providerId };
  }
}
