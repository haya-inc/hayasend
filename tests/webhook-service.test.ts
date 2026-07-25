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
  it("rejects private endpoints before storing them", async () => {
    const service = new WebhookService(
      new MemoryStore(),
      new CapturingJobQueue(),
    );
    await expect(
      service.create({
        endpoint: "https://169.254.169.254/latest/meta-data/",
        events: ["email.sent"],
      }),
    ).rejects.toMatchObject({ name: "validation_error" });
  });

  it("rejects credentials even when local network validation is disabled", async () => {
    const service = new WebhookService(
      new MemoryStore(),
      new CapturingJobQueue(),
      { validateEndpoint: async () => undefined },
    );
    await expect(
      service.create({
        endpoint: "http://user:secret@localhost:3000/hooks",
        events: ["email.sent"],
      }),
    ).rejects.toMatchObject({ name: "validation_error" });
  });

  it("updates destinations, events, and status without rotating the secret", async () => {
    const store = new MemoryStore();
    const validated: string[] = [];
    const service = new WebhookService(
      store,
      new CapturingJobQueue(),
      {
        validateEndpoint: async (endpoint) => {
          validated.push(endpoint.toString());
        },
      },
    );
    const created = await service.create({
      endpoint: "https://example.com/hooks",
      events: ["email.sent"],
    });

    const updated = await service.update(created.webhook.id, {
      endpoint: "https://hooks.example.net/email",
      events: ["email.bounced", "email.bounced"],
      status: "disabled",
    });

    expect(updated).toMatchObject({
      id: created.webhook.id,
      endpoint: "https://hooks.example.net/email",
      events: ["email.bounced"],
      status: "disabled",
    });
    expect(validated).toEqual([
      "https://example.com/hooks",
      "https://hooks.example.net/email",
    ]);
    expect(
      (await store.getWebhook(created.webhook.id))?.signing_secret,
    ).toBe(created.signing_secret);
    await expect(
      service.update(created.webhook.id, {}),
    ).rejects.toMatchObject({ name: "validation_error" });
  });

  it("does not deliver a queued event after its endpoint is disabled", async () => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const calls: string[] = [];
    const service = new WebhookService(store, queue, {
      httpFetch: async (input) => {
        calls.push(String(input));
        return { ok: true, status: 200 };
      },
      validateEndpoint: async () => undefined,
    });
    const created = await service.create({
      endpoint: "https://example.com/hooks",
      events: ["email.sent"],
    });
    await service.publish("email.sent", email);
    const job = queue.jobs[0]?.job;
    if (!job || job.type !== "deliver_webhook") {
      throw new Error("Expected a webhook delivery job.");
    }

    await service.update(created.webhook.id, { status: "disabled" });
    await service.deliver(job.webhook_id, job.event);

    expect(calls).toEqual([]);
  });

  it("publishes only to matching subscriptions and signs delivery", async () => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const httpFetch: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    };
    const service = new WebhookService(store, queue, {
      httpFetch,
      validateEndpoint: async () => undefined,
    });
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
    expect(init?.redirect).toBe("error");
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
