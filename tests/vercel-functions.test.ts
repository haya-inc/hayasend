import type { MessageMetadata } from "@vercel/queue";
import { describe, expect, it } from "vitest";
import {
  isVercelCronRequestAuthorized,
  isVercelQueueWakeup,
  shouldPublishVercelWakeup,
  vercelMaximumTicks,
  vercelQueueRetryDecision,
} from "../src/vercel/functions.js";

const cronSecret = "cron-".repeat(8);

function metadata(deliveryCount: number): MessageMetadata {
  return {
    messageId: "msg_vercel_test",
    deliveryCount,
    createdAt: new Date("2026-07-28T00:00:00Z"),
    expiresAt: new Date("2026-08-04T00:00:00Z"),
    topicName: "hayasend-jobs-v1",
    consumerGroup: "test",
    region: "hnd1",
  };
}

describe("Vercel serverless runtime boundaries", () => {
  it("accepts only the content-free reconciliation wakeup envelope", () => {
    expect(
      isVercelQueueWakeup({
        schema_version: 1,
        kind: "reconcile",
      }),
    ).toBe(true);
    expect(
      isVercelQueueWakeup({
        schema_version: 1,
        kind: "reconcile",
        email_id: "email_forbidden",
      }),
    ).toBe(false);
    expect(
      isVercelQueueWakeup({
        schema_version: 2,
        kind: "reconcile",
      }),
    ).toBe(false);
  });

  it("publishes a wakeup only after successful mutation responses", () => {
    expect(
      shouldPublishVercelWakeup(
        new Request("https://example.test/emails", {
          method: "POST",
        }),
        new Response(null, { status: 202 }),
      ),
    ).toBe(true);
    expect(
      shouldPublishVercelWakeup(
        new Request("https://example.test/emails"),
        new Response(null, { status: 200 }),
      ),
    ).toBe(false);
    expect(
      shouldPublishVercelWakeup(
        new Request("https://example.test/emails", {
          method: "POST",
        }),
        new Response(null, { status: 400 }),
      ),
    ).toBe(false);
  });

  it("fails closed on malformed worker burst limits", () => {
    expect(
      vercelMaximumTicks({
        HAYASEND_VERCEL_MAX_TICKS: "100",
      } as NodeJS.ProcessEnv),
    ).toBe(100);
    for (const invalid of ["0", "101", "1.5", "many"]) {
      expect(() =>
        vercelMaximumTicks({
          HAYASEND_VERCEL_MAX_TICKS: invalid,
        } as NodeJS.ProcessEnv),
      ).toThrow(
        "HAYASEND_VERCEL_MAX_TICKS must be an integer between 1 and 100.",
      );
    }
  });

  it("uses constant-time bearer authorization for Cron", () => {
    const authorized = new Request(
      "https://example.test/api/reconcile",
      {
        headers: { authorization: `Bearer ${cronSecret}` },
      },
    );
    expect(
      isVercelCronRequestAuthorized(authorized, {
        CRON_SECRET: cronSecret,
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isVercelCronRequestAuthorized(
        new Request("https://example.test/api/reconcile"),
        { CRON_SECRET: cronSecret } as NodeJS.ProcessEnv,
      ),
    ).toBe(false);
    expect(() =>
      isVercelCronRequestAuthorized(authorized, {
        CRON_SECRET: "short",
      } as NodeJS.ProcessEnv),
    ).toThrow("CRON_SECRET must contain 32 to 512 characters.");
  });

  it("backs off queue failures and stops after the tenth wakeup", () => {
    expect(
      vercelQueueRetryDecision(new Error("injected"), metadata(1)),
    ).toEqual({ afterSeconds: 5 });
    expect(
      vercelQueueRetryDecision(new Error("injected"), metadata(9)),
    ).toEqual({ afterSeconds: 300 });
    expect(
      vercelQueueRetryDecision(new Error("injected"), metadata(10)),
    ).toEqual({ acknowledge: true });
  });
});
