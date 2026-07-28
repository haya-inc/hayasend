import { describe, expect, it } from "vitest";
import {
  AcsEmailTransport,
  assertAcsEmailPreflight,
  assertAcsEmailRecordPreflight,
  buildAcsEmailMessage,
  estimateAcsSerializedRequestBytes,
  type AcsEmailClient,
} from "../../src/adapters/azure/acs-email-transport.js";
import { safeErrorCategory } from "../../src/core/error-telemetry.js";
import type { EmailRecord } from "../../src/core/types.js";

function email(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: "email_azuretransport0000000000000001",
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

describe("Azure Communication Services Email transport", () => {
  it("estimates a materialized SDK request without double-counting base64", () => {
    const record = email({
      attachments: [
        {
          filename: "small.txt",
          content: "dGVzdA==",
          size_bytes: 4,
        },
      ],
    });
    expect(estimateAcsSerializedRequestBytes(record)).toBe(
      Buffer.byteLength(JSON.stringify(buildAcsEmailMessage(record)), "utf8"),
    );
  });

  it("maps the Resend-shaped record and retains the completed operation ID", async () => {
    const messages: unknown[] = [];
    const client: AcsEmailClient = {
      async beginSend(message) {
        messages.push(structuredClone(message));
        return {
          async pollUntilDone() {
            return {
              id: "b7ce1704-6f17-48ea-bc1c-d5a1904a5220",
              status: "Succeeded",
            };
          },
        };
      },
    };
    const transport = new AcsEmailTransport(client);

    await expect(
      transport.send(
        email({
          html: "<strong>Body</strong>",
          cc: ["copy@example.net"],
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
        }),
      ),
    ).resolves.toEqual({
      provider_id: "b7ce1704-6f17-48ea-bc1c-d5a1904a5220",
    });
    expect(messages).toEqual([
      {
        senderAddress: "sender@example.com",
        content: {
          subject: "Subject",
          html: "<strong>Body</strong>",
          plainText: "Body",
        },
        recipients: {
          to: [
            {
              address: "recipient@example.net",
              displayName: "Recipient",
            },
          ],
          cc: [{ address: "copy@example.net" }],
          bcc: [{ address: "blind@example.net" }],
        },
        headers: { "X-Campaign": "proof" },
        replyTo: [
          {
            address: "reply@example.com",
            displayName: "Support",
          },
        ],
        attachments: [
          {
            name: "pixel.gif",
            contentType: "image/gif",
            contentInBase64: "R0lGODlhAQABAIAAAAUEBA==",
            contentId: "tracking-pixel",
          },
        ],
      },
    ]);
  });

  it.each([
    [400, "provider_rejected"],
    [429, "provider_throttled"],
    [500, "provider_unavailable"],
    [undefined, "provider_error"],
  ])("normalizes status %s without retaining private text", async (status, category) => {
    const transport = new AcsEmailTransport({
      async beginSend() {
        throw {
          statusCode: status,
          code: "AcsFailure",
          message:
            "recipient@example.net private-body re_privatecredential",
        };
      },
    });

    const error = await transport.send(email()).catch(
      (caught: unknown) => caught,
    );
    expect(safeErrorCategory(error)).toBe(category);
    expect(String((error as Error).message)).not.toContain(
      "recipient@example.net",
    );
    expect(String((error as Error).message)).not.toContain("private-body");
    expect(String((error as Error).message)).not.toContain(
      "re_privatecredential",
    );
  });

  it("fails recipient, inline-content, and 10 MB request boundaries before submission", () => {
    expect(() =>
      assertAcsEmailPreflight(
        email({
          to: Array.from(
            { length: 51 },
            (_, index) => `recipient-${index}@example.net`,
          ),
        }),
      ),
    ).toThrow("50 combined recipients");
    expect(() =>
      assertAcsEmailPreflight(
        email({
          attachments: Array.from({ length: 21 }, (_, index) => ({
            filename: `${index}.txt`,
            content: "dGVzdA==",
          })),
        }),
      ),
    ).toThrow("at most 20 attachments");
    expect(() =>
      assertAcsEmailPreflight(
        email({
          attachments: [
            {
              filename: "inline.txt",
              content: "dGVzdA==",
              content_disposition: "inline",
            },
          ],
        }),
      ),
    ).toThrow("require a content ID");
    expect(() =>
      assertAcsEmailPreflight(
        email({ text: "x".repeat(10_000_000) }),
      ),
    ).toThrow("must not exceed 10 MB");
    expect(() =>
      assertAcsEmailRecordPreflight(
        email({
          attachments: [
            {
              attachment_id:
                "att_azuretransport0000000000000001",
              filename: "large.bin",
              size_bytes: 7_500_001,
            },
          ],
        }),
      ),
    ).toThrow("7500000 bytes");
    expect(() =>
      assertAcsEmailRecordPreflight(
        email({
          attachments: [
            {
              attachment_id:
                "att_azuretransport0000000000000002",
              filename: "portable.bin",
              size_bytes: 1_024,
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("treats an unclassified completed-operation failure as retryable", async () => {
    const transport = new AcsEmailTransport({
      async beginSend() {
        return {
          async pollUntilDone() {
            return {
              id: "b7ce1704-6f17-48ea-bc1c-d5a1904a5220",
              status: "Failed",
            };
          },
        };
      },
    });

    const error = await transport.send(email()).catch(
      (caught: unknown) => caught,
    );
    expect(safeErrorCategory(error)).toBe("provider_error");
    expect(error).toMatchObject({ status: 503 });
  });
});
