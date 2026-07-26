import { describe, expect, it, vi } from "vitest";
import { ConsoleMailTransport } from "../src/adapters/ses-transport.js";
import { LocalJobQueue } from "../src/adapters/sqs-job-queue.js";
import {
  safeErrorCategory,
  safeFailureMessage,
  safeRuntimeError,
  shouldRetryOperationalError,
} from "../src/core/error-telemetry.js";
import { ValidationError } from "../src/core/errors.js";
import type { EmailRecord } from "../src/core/types.js";

const SENSITIVE =
  "recipient@example.net A private subject re_secret_token https://user:pass@example.com/hook";

function email(): EmailRecord {
  const now = new Date().toISOString();
  return {
    id: "email_123",
    from: "sender@example.com",
    to: ["recipient@example.net"],
    cc: ["copy@example.net"],
    bcc: ["blind@example.net"],
    subject: "A private subject",
    text: "A private body",
    status: "queued",
    last_event: "queued",
    created_at: now,
    updated_at: now,
    request_hash: "hash",
    attempts: 0,
  };
}

describe("safe error telemetry", () => {
  it("classifies trusted structure without retaining untrusted messages", () => {
    expect(safeErrorCategory(new ValidationError(SENSITIVE))).toBe(
      "validation_error",
    );
    expect(
      safeErrorCategory(
        Object.assign(new Error(SENSITIVE), {
          $metadata: { httpStatusCode: 400 },
        }),
      ),
    ).toBe("provider_rejected");
    expect(
      safeErrorCategory(
        Object.assign(new TypeError(SENSITIVE), {
          cause: { code: "ENOTFOUND", hostname: SENSITIVE },
        }),
      ),
    ).toBe("network_dns");
    expect(safeErrorCategory(new Error(SENSITIVE))).toBe("application_error");
  });

  it.each([
    [{ code: "ECONNREFUSED", message: SENSITIVE }, "network_refused"],
    [{ code: "ECONNRESET", message: SENSITIVE }, "network_reset"],
    [{ code: "ETIMEDOUT", message: SENSITIVE }, "timeout"],
    [{ name: "AbortError", message: SENSITIVE }, "timeout"],
    [new SyntaxError(SENSITIVE), "invalid_data"],
    [{ $metadata: { httpStatusCode: 429 }, message: SENSITIVE }, "provider_throttled"],
    [
      {
        name: "LimitExceededException",
        $metadata: { httpStatusCode: 400 },
        message: SENSITIVE,
      },
      "provider_throttled",
    ],
    [{ $metadata: { httpStatusCode: 503 }, message: SENSITIVE }, "provider_unavailable"],
    [{ $metadata: {}, message: SENSITIVE }, "provider_error"],
  ])("classifies bounded operational signals", (error, expected) => {
    expect(safeErrorCategory(error)).toBe(expected);
  });

  it.each([
    [
      {
        name: "MessageRejected",
        $metadata: { httpStatusCode: 400 },
        message: SENSITIVE,
      },
      false,
    ],
    [new ValidationError(SENSITIVE), false],
    [new SyntaxError(SENSITIVE), false],
    [
      {
        name: "LimitExceededException",
        $metadata: { httpStatusCode: 400 },
        message: SENSITIVE,
      },
      true,
    ],
    [{ $metadata: { httpStatusCode: 429 }, message: SENSITIVE }, true],
    [{ $metadata: { httpStatusCode: 503 }, message: SENSITIVE }, true],
    [{ code: "ECONNRESET", message: SENSITIVE }, true],
    [new Error(SENSITIVE), true],
  ])("makes a privacy-safe retry decision", (error, expected) => {
    expect(shouldRetryOperationalError(error)).toBe(expected);
  });

  it("fails closed for hostile thrown values", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(SENSITIVE);
        },
      },
    );
    expect(safeErrorCategory(hostile)).toBe("application_error");
    expect(shouldRetryOperationalError(hostile)).toBe(true);
    const message = safeFailureMessage("Email delivery failed", hostile);
    expect(message).toBe("Email delivery failed (application_error).");
    expect(message).not.toContain(SENSITIVE);
  });

  it("creates a retryable runtime error without the original cause", () => {
    const error = safeRuntimeError(
      "Inbound email processing failed",
      new Error(SENSITIVE),
    );
    expect(error).toMatchObject({
      name: "HayaSendOperationalError",
      message: "Inbound email processing failed (application_error).",
    });
    expect(error).not.toHaveProperty("cause");
    expect(error.stack).not.toContain(SENSITIVE);
  });

  it("keeps local acceptance logs free of message metadata", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await new ConsoleMailTransport().send(email());

    const output = info.mock.calls.flat().join(" ");
    expect(output).toContain('"recipient_count":3');
    expect(output).not.toContain("sender@example.com");
    expect(output).not.toContain("recipient@example.net");
    expect(output).not.toContain("A private subject");
    expect(output).not.toContain("A private body");
    info.mockRestore();
  });

  it("keeps local asynchronous failure logs free of thrown details", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const queue = new LocalJobQueue();
    queue.setHandler(async () => {
      throw new Error(SENSITIVE);
    });

    await queue.enqueue({ type: "send_email", email_id: "email_123" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const output = errors.mock.calls.flat().join(" ");
    expect(output).toContain('"error_type":"application_error"');
    expect(output).not.toContain(SENSITIVE);
    errors.mockRestore();
  });
});
