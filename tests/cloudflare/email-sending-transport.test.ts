import { describe, expect, it } from "vitest";
import {
  assertCloudflareEmailPreflight,
  CloudflareEmailSendingTransport,
} from "../../src/adapters/cloudflare/email-sending-transport.js";
import { safeErrorCategory } from "../../src/core/error-telemetry.js";
import type { EmailRecord } from "../../src/core/types.js";

function email(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: "email_cloudflaretransport00000000000001",
    from: "sender@example.com",
    to: ["recipient@example.net"],
    subject: "Subject",
    text: "Body",
    status: "sending",
    last_event: "sending",
    created_at: "2026-07-27T14:00:00.000Z",
    updated_at: "2026-07-27T14:00:01.000Z",
    request_hash: "0".repeat(64),
    attempts: 1,
    ...overrides,
  };
}

describe("Cloudflare Email Sending transport", () => {
  it("maps the Resend-shaped record to the binding and retains messageId", async () => {
    const sent: EmailMessageBuilder[] = [];
    const transport = new CloudflareEmailSendingTransport({
      async send(message) {
        sent.push(structuredClone(message));
        return {
          messageId: "<cf-provider-message-1@hayasend.com>",
        };
      },
    });

    await expect(
      transport.send(
        email({
          html: "<strong>Body</strong>",
          cc: ["copy@example.net"],
          reply_to: ["reply@example.com"],
          headers: { "X-Campaign": "proof" },
          attachments: [
            {
              filename: "proof.txt",
              content: "cHJvb2Y=",
              content_type: "text/plain",
              content_disposition: "attachment",
              size_bytes: 5,
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      provider_id: "<cf-provider-message-1@hayasend.com>",
    });
    expect(sent).toEqual([
      expect.objectContaining({
        from: "sender@example.com",
        to: ["recipient@example.net"],
        cc: ["copy@example.net"],
        replyTo: "reply@example.com",
        headers: { "X-Campaign": "proof" },
        attachments: [
          expect.objectContaining({
            disposition: "attachment",
            content: "cHJvb2Y=",
          }),
        ],
      }),
    ]);
  });

  it.each([
    ["E_VALIDATION_ERROR", "invalid_data"],
    ["E_RECIPIENT_SUPPRESSED", "provider_rejected"],
    ["E_RATE_LIMIT_EXCEEDED", "provider_throttled"],
    ["E_INTERNAL_SERVER_ERROR", "provider_unavailable"],
    ["E_FUTURE_ERROR", "provider_error"],
  ])("normalizes %s without retaining provider text", async (code, category) => {
    const transport = new CloudflareEmailSendingTransport({
      async send() {
        throw {
          code,
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
    expect(String((error as Error).message)).not.toContain(
      "private-body",
    );
    expect(String((error as Error).message)).not.toContain(
      "re_privatecredential",
    );
  });

  it("fails documented recipient and 5 MiB boundaries before binding use", () => {
    expect(() =>
      assertCloudflareEmailPreflight(
        email({
          to: Array.from(
            { length: 51 },
            (_, index) => `recipient-${index}@example.net`,
          ),
        }),
      ),
    ).toThrow("50 combined recipients");
    expect(() =>
      assertCloudflareEmailPreflight(
        email({ text: "x".repeat(5 * 1024 * 1024) }),
      ),
    ).toThrow("must not exceed 5 MiB");
  });
});
