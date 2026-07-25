import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryAttachmentStorage } from "../src/adapters/attachment-storage.js";
import { MemoryInboundStorage } from "../src/adapters/inbound-storage.js";
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
import { AttachmentService } from "../src/services/attachment-service.js";
import { DomainService } from "../src/services/domain-service.js";
import { EmailService } from "../src/services/email-service.js";
import { ReceivedEmailService } from "../src/services/received-email-service.js";
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
  const webhooks = new WebhookService(store, queue, {
    validateEndpoint: async () => undefined,
  });
  const inboundStorage = new MemoryInboundStorage();
  const receivedEmailService = new ReceivedEmailService(
    store,
    inboundStorage,
    queue,
    webhooks,
    {
      rawPrefix: "inbound/raw/",
      retentionDays: 7,
      maxMessageBytes: 25 * 1024 * 1024,
    },
  );
  const suppressions = new SuppressionService(store);
  const apiKeys = new ApiKeyService(store, "re_test_secret");
  const attachments = new AttachmentService(
    store,
    new MemoryAttachmentStorage(),
  );
  const transport = new RecordingTransport();
  const scheduler = new QueueEmailScheduler(queue);
  const emails = new EmailService(
    store,
    scheduler,
    transport,
    webhooks,
    suppressions,
    attachments,
  );
  const domains = new DomainService(
    store,
    new LocalDomainProvider(),
    "ap-northeast-1",
  );
  const app = createApp({
    apiKeyService: apiKeys,
    attachmentService: attachments,
    domainService: domains,
    emailService: emails,
    receivedEmailService,
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
    attachments,
    domains,
    emails,
    inboundStorage,
    queue,
    receivedEmailService,
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

  it("lists and retrieves received emails before the generic email route", async () => {
    const {
      inboundStorage,
      receivedEmailService,
      request,
    } = fixture();
    inboundStorage.seedRaw(
      "inbound/raw/aws-inbound-api",
      [
        "From: Sender <sender@example.com>",
        "To: inbound@example.net",
        "Message-ID: <api-test@example.com>",
        "Subject: Received through API",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Inbound body",
      ].join("\r\n"),
    );
    const record = await receivedEmailService.ingest({
      provider_message_id: "aws-inbound-api",
      source: "sender@example.com",
      destinations: ["inbound@example.net"],
      timestamp: "2026-07-26T08:00:00.000Z",
      verdicts: {},
    });

    const list = await request("/emails/receiving");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      object: "list",
      data: [
        {
          id: record?.id,
          subject: "Received through API",
        },
      ],
    });

    const retrieved = await request(
      `/emails/receiving/${record?.id}`,
    );
    expect(retrieved.status).toBe(200);
    await expect(retrieved.json()).resolves.toMatchObject({
      object: "email",
      id: record?.id,
      text: expect.stringContaining("Inbound body"),
      raw: {
        download_url: expect.stringContaining(
          "https://local.hayasend.invalid/inbound/",
        ),
      },
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
    const { queue, request, webhooks } = fixture();
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
    const webhookBody = (await webhook.json()) as {
      id: string;
      signing_secret: string;
    };
    expect(webhookBody).toMatchObject({
      id: expect.stringMatching(/^wh_/),
      signing_secret: expect.stringMatching(/^whsec_/),
    });
    await webhooks.publishData("email.sent", {
      created_at: "2026-07-26T00:00:00.000Z",
      email_id: "email_delivery_history",
      from: "sender@example.com",
      to: ["recipient@example.net"],
      subject: "Webhook history",
    });
    const deliveryJob = queue.jobs
      .map(({ job }) => job)
      .find((job) => job.type === "deliver_webhook");
    if (!deliveryJob || deliveryJob.type !== "deliver_webhook") {
      throw new Error("Expected a webhook delivery job.");
    }
    const deliveryId = deliveryJob.delivery_id ?? "";
    const deliveries = await request(
      `/webhooks/${webhookBody.id}/deliveries`,
    );
    await expect(deliveries.json()).resolves.toMatchObject({
      object: "list",
      data: [
        {
          object: "webhook_delivery",
          id: deliveryId,
          status: "pending",
        },
      ],
    });
    const delivery = await request(
      `/webhooks/${webhookBody.id}/deliveries/${deliveryId}`,
    );
    await expect(delivery.json()).resolves.toMatchObject({
      object: "webhook_delivery",
      id: deliveryId,
      event: {
        type: "email.sent",
        data: { email_id: "email_delivery_history" },
      },
    });
    const updatedWebhook = await request(
      `/webhooks/${webhookBody.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          events: ["email.delivered"],
          status: "disabled",
        }),
      },
    );
    await expect(updatedWebhook.json()).resolves.toEqual({
      object: "webhook",
      id: webhookBody.id,
    });
    const retrievedWebhook = await request(
      `/webhooks/${webhookBody.id}`,
    );
    const retrievedWebhookBody = (await retrievedWebhook.json()) as Record<
      string,
      unknown
    >;
    expect(retrievedWebhookBody).toMatchObject({
      id: webhookBody.id,
      events: ["email.delivered"],
      status: "disabled",
    });
    expect(retrievedWebhookBody).not.toHaveProperty("signing_secret");
    const emptyUpdate = await request(`/webhooks/${webhookBody.id}`, {
      method: "PATCH",
      body: "{}",
    });
    expect(emptyUpdate.status).toBe(422);
    await request(`/webhooks/${webhookBody.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "enabled" }),
    });
    const replay = await request(
      `/webhooks/${webhookBody.id}/deliveries/${deliveryId}/replay`,
      { method: "POST" },
    );
    const replayBody = (await replay.json()) as {
      id: string;
      replayed_from: string;
    };
    expect(replayBody).toMatchObject({
      id: expect.stringMatching(/^msg_/),
      replayed_from: deliveryId,
    });
    expect(replayBody.id).not.toBe(deliveryId);
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

  it("uploads a checksum-bound attachment without exposing its content", async () => {
    const { app, emails, request, transport } = fixture();
    const content = Buffer.from("private attachment content");
    const checksum = createHash("sha256").update(content).digest("hex");
    const createUpload = await request("/attachments", {
      method: "POST",
      body: JSON.stringify({
        filename: "invoice.txt",
        content_type: "text/plain",
        size_bytes: content.byteLength,
        checksum_sha256: checksum,
      }),
    });
    expect(createUpload.status).toBe(200);
    const upload = (await createUpload.json()) as {
      id: string;
      upload_url: string;
      upload_headers: Record<string, string>;
    };

    const tamperedUrl = new URL(upload.upload_url);
    tamperedUrl.searchParams.set("token", "wrong");
    const deniedUpload = await app.request(tamperedUrl, {
      method: "PUT",
      headers: upload.upload_headers,
      body: content,
    });
    expect(deniedUpload.status).toBe(422);

    const uploaded = await app.request(upload.upload_url, {
      method: "PUT",
      headers: upload.upload_headers,
      body: content,
    });
    expect(uploaded.status).toBe(204);

    const send = await request("/emails", {
      method: "POST",
      body: JSON.stringify({
        ...email,
        attachments: [{ attachment_id: upload.id }],
      }),
    });
    expect(send.status).toBe(200);
    const { id } = (await send.json()) as { id: string };
    const retrieved = (await (
      await request(`/emails/${id}`)
    ).json()) as Record<string, unknown>;
    expect(retrieved.attachments).toEqual([
      {
        attachment_id: upload.id,
        filename: "invoice.txt",
        content_type: "text/plain",
      },
    ]);
    expect(JSON.stringify(retrieved)).not.toContain(
      content.toString("base64"),
    );
    expect(JSON.stringify(retrieved)).not.toContain("object_key");
    expect(JSON.stringify(retrieved)).not.toContain(checksum);

    await emails.processSend(id);
    expect(transport.sent[0]?.attachments?.[0]).toMatchObject({
      filename: "invoice.txt",
      content: content.toString("base64"),
    });
    expect(transport.sent[0]?.attachments?.[0]).not.toHaveProperty(
      "object_key",
    );
  });

  it("never returns inline attachment bodies from email reads", async () => {
    const { request } = fixture();
    const content = Buffer.from("inline private content").toString("base64");
    const sent = await request("/emails", {
      method: "POST",
      body: JSON.stringify({
        ...email,
        attachments: [{ filename: "inline.txt", content }],
      }),
    });
    const { id } = (await sent.json()) as { id: string };

    const retrieved = await request(`/emails/${id}`);
    await expect(retrieved.json()).resolves.toMatchObject({
      attachments: [{ filename: "inline.txt" }],
    });
    expect(await (await request(`/emails/${id}`)).text()).not.toContain(
      content,
    );
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
