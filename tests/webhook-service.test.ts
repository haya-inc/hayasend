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
  provider_id: "ses-message-id",
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
    await service.deliver(
      job.webhook_id,
      job.event,
      job.delivery_id,
    );

    expect(calls).toEqual([]);
    await expect(
      service.getDelivery(
        created.webhook.id,
        job.delivery_id ?? "",
      ),
    ).resolves.toMatchObject({
      status: "cancelled",
      attempts: 0,
    });
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

    await service.deliver(
      job.webhook_id,
      job.event,
      job.delivery_id,
    );
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] ?? [];
    expect(url).toBe("https://example.com/hooks");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("svix-id")).toBe(job.delivery_id);
    const payload = String(init?.body);
    expect(headers.get("svix-signature")).toBe(
      signWebhook(
        created.signing_secret,
        headers.get("svix-id") ?? "",
        headers.get("svix-timestamp") ?? "",
        payload,
      ),
    );
    const deliveries = await service.listDeliveries(
      created.webhook.id,
      20,
    );
    expect(deliveries.data).toHaveLength(1);
    expect(deliveries.data[0]).toMatchObject({
      object: "webhook_delivery",
      id: job.delivery_id,
      status: "succeeded",
      attempts: 1,
      response_status: 204,
    });
    expect(deliveries.data[0]).not.toHaveProperty("event");
    await expect(
      service.getDelivery(
        created.webhook.id,
        job.delivery_id ?? "",
      ),
    ).resolves.toMatchObject({
      event: {
        type: "email.sent",
        data: {
          email_id: email.id,
          message_id: "ses-message-id",
        },
      },
    });

    const replay = await service.replay(
      created.webhook.id,
      job.delivery_id ?? "",
    );
    expect(replay).toMatchObject({
      status: "pending",
      attempts: 0,
      replayed_from: job.delivery_id,
    });
    expect(replay.id).not.toBe(job.delivery_id);
    expect(queue.jobs[1]?.job).toMatchObject({
      type: "deliver_webhook",
      webhook_id: created.webhook.id,
      delivery_id: replay.id,
    });
  });

  it("omits message_id from events emitted before provider acceptance", async () => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const service = new WebhookService(store, queue, {
      validateEndpoint: async () => undefined,
    });
    await service.create({
      endpoint: "https://example.com/hooks",
      events: ["email.scheduled"],
    });

    await service.publish("email.scheduled", {
      ...email,
      provider_id: undefined,
      status: "scheduled",
      last_event: "scheduled",
    });

    const job = queue.jobs[0]?.job;
    expect(job?.type).toBe("deliver_webhook");
    if (!job || job.type !== "deliver_webhook") {
      throw new Error("Expected a webhook delivery job.");
    }
    expect(job.event.data).not.toHaveProperty("message_id");
  });

  it.each([
    "email.sent",
    "email.delivered",
    "email.delivery_delayed",
    "email.opened",
    "email.clicked",
    "email.bounced",
    "email.complained",
    "email.failed",
  ] as const)("includes message_id in provider-accepted %s events", async (type) => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const service = new WebhookService(store, queue, {
      validateEndpoint: async () => undefined,
    });
    await service.create({
      endpoint: "https://example.com/hooks",
      events: [type],
    });

    await service.publish(type, email);

    expect(queue.jobs[0]?.job).toMatchObject({
      type: "deliver_webhook",
      event: {
        type,
        data: {
          email_id: email.id,
          message_id: "ses-message-id",
        },
      },
    });
  });

  it("keeps one delivery ID and records failure across automatic retries", async () => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const messageIds: string[] = [];
    let attempt = 0;
    const service = new WebhookService(store, queue, {
      httpFetch: async (_input, init) => {
        messageIds.push(new Headers(init?.headers).get("svix-id") ?? "");
        attempt += 1;
        return attempt === 1
          ? { ok: false, status: 503 }
          : { ok: true, status: 204 };
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

    await expect(
      service.deliver(
        "wh_wrong_endpoint",
        job.event,
        job.delivery_id,
        1,
      ),
    ).rejects.toThrow("does not belong");
    await expect(
      service.deliver(
        job.webhook_id,
        job.event,
        job.delivery_id,
        1,
      ),
    ).rejects.toThrow("HTTP 503");
    await expect(
      service.getDelivery(
        created.webhook.id,
        job.delivery_id ?? "",
      ),
    ).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      response_status: 503,
      last_error: "HTTP 503",
    });

    await service.deliver(
      job.webhook_id,
      job.event,
      job.delivery_id,
      2,
    );
    expect(messageIds).toEqual([job.delivery_id, job.delivery_id]);
    await expect(
      service.getDelivery(
        created.webhook.id,
        job.delivery_id ?? "",
      ),
    ).resolves.toMatchObject({
      status: "succeeded",
      attempts: 2,
      response_status: 204,
    });
  });

  it("does not retain sensitive network error text", async () => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const sensitive =
      "recipient@example.net private body re_secret_token https://example.com/hook";
    const service = new WebhookService(store, queue, {
      httpFetch: async () => {
        throw Object.assign(new TypeError(sensitive), {
          cause: { code: "ENOTFOUND", hostname: sensitive },
        });
      },
      validateEndpoint: async () => undefined,
    });
    const created = await service.create({
      endpoint: "https://example.com/hook",
      events: ["email.sent"],
    });
    await service.publish("email.sent", email);
    const job = queue.jobs[0]?.job;
    if (!job || job.type !== "deliver_webhook") {
      throw new Error("Expected a webhook delivery job.");
    }

    await expect(
      service.deliver(
        job.webhook_id,
        job.event,
        job.delivery_id,
        1,
      ),
    ).rejects.toThrow(sensitive);

    const delivery = await service.getDelivery(
      created.webhook.id,
      job.delivery_id ?? "",
    );
    expect(delivery.last_error).toBe(
      "Webhook delivery failed (network_dns).",
    );
    expect(JSON.stringify(delivery)).not.toContain(sensitive);
  });
});
