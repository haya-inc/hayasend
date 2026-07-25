import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import { signWebhook } from "../src/core/crypto.js";
import type { EmailRecord } from "../src/core/types.js";
import { WebhookService } from "../src/services/webhook-service.js";

const email: EmailRecord = {
  id: "email_123",
  from: "sender@example.com",
  to: ["recipient@example.net"],
  subject: "Subject",
  text: "Body",
  status: "sent",
  last_event: "sent",
  created_at: "2026-07-26T00:00:00.000Z",
  updated_at: "2026-07-26T00:00:01.000Z",
  request_hash: "hash",
  attempts: 1,
};

describe("WebhookService", () => {
  it("publishes only to matching subscriptions and signs delivery", async () => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const httpFetch: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    };
    const service = new WebhookService(store, queue, httpFetch);
    const created = await service.create({
      endpoint: "https://example.com/hooks",
      events: ["email.sent"],
    });
    await service.create({
      endpoint: "https://example.net/hooks",
      events: ["email.bounced"],
    });

    await service.publish("email.sent", email);
    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0]?.job;
    expect(job?.type).toBe("deliver_webhook");
    if (!job || job.type !== "deliver_webhook") {
      throw new Error("Expected a webhook delivery job.");
    }

    await service.deliver(job.webhook_id, job.event);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] ?? [];
    expect(url).toBe("https://example.com/hooks");
    const headers = new Headers(init?.headers);
    const payload = String(init?.body);
    expect(headers.get("svix-signature")).toBe(
      signWebhook(
        created.signing_secret,
        headers.get("svix-id") ?? "",
        headers.get("svix-timestamp") ?? "",
        payload,
      ),
    );
  });
});
