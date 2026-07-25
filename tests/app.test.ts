import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { LocalDomainProvider } from "../src/adapters/ses-domain-provider.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { QueueEmailScheduler } from "../src/adapters/email-scheduler.js";
import type { EmailRecord } from "../src/core/types.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../src/ports/mail-transport.js";
import { ApiKeyService } from "../src/services/api-key-service.js";
import { DomainService } from "../src/services/domain-service.js";
import { EmailService } from "../src/services/email-service.js";
import { SuppressionService } from "../src/services/suppression-service.js";
import { WebhookService } from "../src/services/webhook-service.js";

class RecordingTransport implements MailTransport {
  readonly sent: EmailRecord[] = [];

  async send(email: EmailRecord): Promise<MailTransportResult> {
    this.sent.push(structuredClone(email));
    return { provider_id: `provider_${email.id}` };
  }
}

function fixture() {
  const store = new MemoryStore();
  const queue = new CapturingJobQueue();
  const webhooks = new WebhookService(store, queue);
  const suppressions = new SuppressionService(store);
  const apiKeys = new ApiKeyService(store, "re_test_secret");
  const transport = new RecordingTransport();
  const scheduler = new QueueEmailScheduler(queue);
  const emails = new EmailService(
    store,
    scheduler,
    transport,
    webhooks,
    suppressions,
  );
  const domains = new DomainService(
    store,
    new LocalDomainProvider(),
    "ap-northeast-1",
  );
  const app = createApp({
    apiKeyService: apiKeys,
    domainService: domains,
    emailService: emails,
    suppressionService: suppressions,
    webhookService: webhooks,
  });
  const request = (
    path: string,
    init: RequestInit = {},
    key = "re_test_secret",
  ) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  return {
    apiKeys,
    app,
    domains,
    emails,
    queue,
    request,
    store,
    suppressions,
    transport,
    webhooks,
  };
}

const email = {
  from: "HayaSend <hello@example.com>",
  to: "person@example.net",
  subject: "Hello",
  text: "A transactional email.",
};

describe("HTTP API", () => {
  it("exposes a public health check and protects API routes", async () => {
    const { app, request } = fixture();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    const unauthorized = await request("/emails", {}, "wrong");
    expect(unauthorized.status).toBe(401);
  });

  it("accepts a Resend-shaped email request", async () => {
    const { queue, request } = fixture();
    const response = await request("/emails", {
      method: "POST",
      body: JSON.stringify(email),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toMatch(/^email_/);
    expect(queue.jobs).toEqual([
      {
        job: { type: "send_email", email_id: body.id },
        delaySeconds: 0,
      },
    ]);

    const retrieved = await request(`/emails/${body.id}`);
    await expect(retrieved.json()).resolves.toMatchObject({
      id: body.id,
      status: "queued",
      from: email.from,
      to: [email.to],
      subject: email.subject,
    });
  });

  it("replays identical idempotent requests without a second job", async () => {
    const { queue, request } = fixture();
    const init = {
      method: "POST",
      headers: { "idempotency-key": "checkout-42" },
      body: JSON.stringify(email),
    };
    const first = (await (await request("/emails", init)).json()) as {
      id: string;
    };
    const second = (await (await request("/emails", init)).json()) as {
      id: string;
    };
    expect(second.id).toBe(first.id);
    expect(queue.jobs).toHaveLength(1);

    const conflict = await request("/emails", {
      ...init,
      body: JSON.stringify({ ...email, subject: "Changed" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("supports batches, domains, and signed webhook registration", async () => {
    const { request } = fixture();
    const batch = await request("/emails/batch", {
      method: "POST",
      body: JSON.stringify([email, { ...email, to: ["second@example.net"] }]),
    });
    const batchBody = (await batch.json()) as {
      data: Array<{ id: string }>;
    };
    expect(batchBody.data).toHaveLength(2);

    const domain = await request("/domains", {
      method: "POST",
      body: JSON.stringify({ name: "example.com" }),
    });
    await expect(domain.json()).resolves.toMatchObject({
      name: "example.com",
      status: "verified",
    });

    const webhook = await request("/webhooks", {
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://example.com/webhooks/email",
        events: ["email.sent", "email.bounced"],
      }),
    });
    await expect(webhook.json()).resolves.toMatchObject({
      id: expect.stringMatching(/^wh_/),
      signing_secret: expect.stringMatching(/^whsec_/),
    });
  });

  it("rejects unsupported attachment URLs rather than fetching them", async () => {
    const { request } = fixture();
    const response = await request("/emails", {
      method: "POST",
      body: JSON.stringify({
        ...email,
        attachments: [
          {
            filename: "unsafe.txt",
            path: "http://169.254.169.254/latest/meta-data/",
          },
        ],
      }),
    });
    expect(response.status).toBe(422);
  });

  it("issues hashed scoped API keys and enforces least privilege", async () => {
    const { request } = fixture();
    const createdResponse = await request("/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: "transactional sender",
        scopes: ["emails:send"],
      }),
    });
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as {
      id: string;
      token: string;
    };
    expect(created.token).toMatch(/^re_hs_key_[a-f0-9]{32}\./);

    const sent = await request(
      "/emails",
      {
        method: "POST",
        body: JSON.stringify(email),
      },
      created.token,
    );
    expect(sent.status).toBe(200);

    const forbidden = await request("/domains", {}, created.token);
    expect(forbidden.status).toBe(403);

    const list = (await (await request("/api-keys")).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(list.data[0]).not.toHaveProperty("token");
    expect(list.data[0]).not.toHaveProperty("key_hash");

    const revoked = await request(`/api-keys/${created.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    const denied = await request(
      "/emails",
      {
        method: "POST",
        body: JSON.stringify(email),
      },
      created.token,
    );
    expect(denied.status).toBe(401);
  });

  it("prevents a scoped API key from escalating its authority", async () => {
    const { request } = fixture();
    const managerResponse = await request("/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: "key manager",
        scopes: ["api_keys:write"],
      }),
    });
    const manager = (await managerResponse.json()) as { token: string };

    const escalation = await request(
      "/api-keys",
      {
        method: "POST",
        body: JSON.stringify({
          name: "escalated sender",
          scopes: ["emails:send"],
        }),
      },
      manager.token,
    );

    expect(escalation.status).toBe(403);
  });

  it("suppresses a manually blocked recipient without enqueueing SES work", async () => {
    const { queue, request } = fixture();
    const suppression = await request("/suppressions", {
      method: "POST",
      body: JSON.stringify({
        email: "blocked@example.net",
        reason: "manual",
      }),
    });
    expect(suppression.status).toBe(200);

    const send = await request("/emails", {
      method: "POST",
      body: JSON.stringify({ ...email, to: "blocked@example.net" }),
    });
    const { id } = (await send.json()) as { id: string };
    const stored = await request(`/emails/${id}`);
    await expect(stored.json()).resolves.toMatchObject({
      status: "suppressed",
      last_event: "suppressed",
    });
    expect(queue.jobs).toHaveLength(0);
  });
});
