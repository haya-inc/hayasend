import { describe, expect, it, vi } from "vitest";
import {
  SENDGRID_MAX_COMBINED_RECIPIENTS,
  SendGridMailTransport,
  assertSendGridEmailRecordPreflight,
  buildSendGridMailRequest,
  sendGridProviderMessageId,
} from "../../src/adapters/sendgrid/sendgrid-email-transport.js";
import type { EmailRecord } from "../../src/core/types.js";

function email(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: "email_sendgridtransport00000000000001",
    from: "HayaSend <sender@example.com>",
    to: ["Recipient <recipient@example.net>"],
    subject: "Subject",
    text: "Body",
    status: "sending",
    last_event: "sending",
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:01.000Z",
    request_hash: "0".repeat(64),
    attempts: 1,
    ...overrides,
  };
}

describe("SendGrid mail transport", () => {
  it("maps the Resend-shaped record with opaque recipient-event correlation", async () => {
    const request = vi.fn(async () => new Response(null, { status: 202 }));
    const record = email({
      html: "<strong>Body</strong>",
      cc: ["Copy <copy@example.net>"],
      bcc: ["blind@example.net"],
      reply_to: ["Support <reply@example.com>"],
      headers: { "X-Campaign": "proof" },
      attachments: [
        {
          filename: "pixel.gif",
          content: "R0lGODlhAQABAIAAAAUEBA==",
          content_type: "image/gif",
          content_disposition: "inline",
          content_id: "tracking-pixel",
          size_bytes: 16,
        },
      ],
    });
    const transport = new SendGridMailTransport({ request });

    await expect(transport.send(record)).resolves.toEqual({
      provider_id: sendGridProviderMessageId(record),
    });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v3/mail/send",
      expected_statuses: [202],
      body: {
        personalizations: [
          {
            to: [
              {
                email: "recipient@example.net",
                name: "Recipient",
              },
            ],
            cc: [{ email: "copy@example.net", name: "Copy" }],
            bcc: [{ email: "blind@example.net" }],
            custom_args: {
              hayasend_message_id: record.id,
              hayasend_provider_id: `<${record.id}@example.com>`,
            },
          },
        ],
        from: { email: "sender@example.com", name: "HayaSend" },
        reply_to_list: [
          { email: "reply@example.com", name: "Support" },
        ],
        subject: "Subject",
        content: [
          { type: "text/plain", value: "Body" },
          { type: "text/html", value: "<strong>Body</strong>" },
        ],
        headers: {
          "X-Campaign": "proof",
          "Message-ID": `<${record.id}@example.com>`,
        },
        attachments: [
          {
            content: "R0lGODlhAQABAIAAAAUEBA==",
            filename: "pixel.gif",
            type: "image/gif",
            disposition: "inline",
            content_id: "tracking-pixel",
          },
        ],
      },
    });
  });

  it("fails closed at recipient, attachment, reserved-header, and size boundaries", () => {
    expect(() =>
      assertSendGridEmailRecordPreflight(
        email({
          to: Array.from(
            { length: SENDGRID_MAX_COMBINED_RECIPIENTS + 1 },
            (_, index) => `recipient-${index}@example.net`,
          ),
        }),
      ),
    ).toThrow("1000 combined recipients");
    expect(() =>
      assertSendGridEmailRecordPreflight(
        email({
          attachments: Array.from({ length: 21 }, (_, index) => ({
            filename: `${index}.txt`,
            content: "dGVzdA==",
          })),
        }),
      ),
    ).toThrow("at most 20 attachments");
    expect(() =>
      assertSendGridEmailRecordPreflight(
        email({ headers: { "message-id": "<forged@example.net>" } }),
      ),
    ).toThrow("reserved delivery headers");
    expect(() =>
      assertSendGridEmailRecordPreflight(
        email({
          attachments: [
            {
              attachment_id: "att_sendgridtransport000000000001",
              filename: "too-large.bin",
              size_bytes: 20_000_001,
            },
          ],
        }),
      ),
    ).toThrow("20000000 bytes");
  });

  it("does not silently remove reserved headers while building requests", () => {
    const record = email({
      headers: {
        Subject: "forged",
        "X-Safe": "retained",
      },
    });
    expect(() => assertSendGridEmailRecordPreflight(record)).toThrow(
      "reserved delivery headers",
    );
    expect(buildSendGridMailRequest(record).headers).toEqual({
      "X-Safe": "retained",
      "Message-ID": `<${record.id}@example.com>`,
    });
  });
});
