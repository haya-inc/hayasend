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
import { TemplateService } from "../src/services/template-service.js";

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
  const templates = new TemplateService(store);
  const emails = new EmailService(
    store,
    scheduler,
    transport,
    webhooks,
    suppressions,
    attachments,
    templates,
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
    templateService: templates,
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
    templates,
    transport,
    webhooks,
  };
}

function previewFixture() {
  const result = fixture();
  return {
    ...result,
    app: createApp(
      {
        apiKeyService: result.apiKeys,
        attachmentService: result.attachments,
        domainService: result.domains,
        emailService: result.emails,
        receivedEmailService: result.receivedEmailService,
        suppressionService: result.suppressions,
        templateService: result.templates,
        webhookService: result.webhooks,
      },
      { localPreview: true },
    ),
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

  it("renders a template draft with read scope without queueing an email", async () => {
    const { queue, request, transport } = fixture();
    const created = await request("/templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Preview",
        alias: "preview",
        from: "Product <hello@example.com>",
        subject: "Hello {{{NAME}}}",
        html: "<p>Hello {{{NAME}}}</p>",
        variables: [{ key: "NAME", type: "string" }],
      }),
    });
    expect(created.status).toBe(200);

    const keyResponse = await request("/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: "template reviewer",
        scopes: ["templates:read"],
      }),
    });
    const key = (await keyResponse.json()) as { token: string };
    const rendered = await request(
      "/templates/preview/render",
      {
        method: "POST",
        body: JSON.stringify({ variables: { NAME: "Ada & Lin" } }),
      },
      key.token,
    );

    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("etag")).toMatch(/^"tmplv_[a-f0-9]{32}"$/);
    await expect(rendered.json()).resolves.toMatchObject({
      object: "template_render",
      from: "Product <hello@example.com>",
      subject: "Hello Ada & Lin",
      html: "<p>Hello Ada &amp; Lin</p>",
      text: "Hello Ada & Lin",
    });
    expect(queue.jobs).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
    const forbiddenPublish = await request(
      "/templates/preview/publish",
      { method: "POST" },
      key.token,
    );
    expect(forbiddenPublish.status).toBe(403);

    const retrieved = await request("/templates/preview");
    const reviewed = (await retrieved.json()) as {
      current_version_id: string;
    };
    expect(retrieved.headers.get("etag")).toBe(
      `"${reviewed.current_version_id}"`,
    );
    await request("/templates/preview", {
      method: "PATCH",
      body: JSON.stringify({ subject: "A newer draft" }),
    });
    const stalePublish = await request("/templates/preview/publish", {
      method: "POST",
      headers: { "if-match": `"${reviewed.current_version_id}"` },
    });
    expect(stalePublish.status).toBe(412);
    const malformedVersion = await request("/templates/preview/publish", {
      method: "POST",
      headers: { "if-match": "not-a-version" },
    });
    expect(malformedVersion.status).toBe(422);
  });

  it("authorizes version history separately and restores with a current-draft precondition", async () => {
    const { request } = fixture();
    const createdResponse = await request("/templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Historical",
        alias: "historical",
        html: "<p>Known good</p>",
      }),
    });
    const created = (await createdResponse.json()) as { id: string };
    const currentResponse = await request(`/templates/${created.id}`);
    const current = (await currentResponse.json()) as {
      current_version_id: string;
    };
    const published = await request(`/templates/${created.id}/publish`, {
      method: "POST",
      headers: {
        "if-match": `"${current.current_version_id}"`,
        "x-hayasend-source": "cli",
      },
    });
    expect(published.status).toBe(200);

    const readerResponse = await request("/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: "history reviewer",
        scopes: ["templates:read"],
      }),
    });
    const reader = (await readerResponse.json()) as { token: string };
    const versionsResponse = await request(
      `/templates/${created.id}/versions?limit=1`,
      {},
      reader.token,
    );
    expect(versionsResponse.status).toBe(200);
    const versions = (await versionsResponse.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(versions.data).toHaveLength(1);
    expect(versions.data[0]).toMatchObject({
      object: "template_version",
      id: current.current_version_id,
      template_id: created.id,
      actor: {
        id: "bootstrap",
        name: "Bootstrap administrator",
      },
      source: "cli",
      source_version_id: null,
    });
    expect(versions.data[0]).not.toHaveProperty("html");
    expect(versions.data[0]).not.toHaveProperty("text");

    const inspected = await request(
      `/templates/${created.id}/versions/${current.current_version_id}`,
      {},
      reader.token,
    );
    expect(inspected.status).toBe(200);
    await expect(inspected.json()).resolves.toMatchObject({
      object: "template_version",
      id: current.current_version_id,
      html: "<p>Known good</p>",
    });
    const rendered = await request(
      `/templates/${created.id}/versions/${current.current_version_id}/render`,
      { method: "POST", body: "{}" },
      reader.token,
    );
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("etag")).toBe(
      `"${current.current_version_id}"`,
    );

    const forbiddenRestore = await request(
      `/templates/${created.id}/versions/${current.current_version_id}/restore`,
      {
        method: "POST",
        headers: { "if-match": `"${current.current_version_id}"` },
      },
      reader.token,
    );
    expect(forbiddenRestore.status).toBe(403);
    const missingPrecondition = await request(
      `/templates/${created.id}/versions/${current.current_version_id}/restore`,
      { method: "POST" },
    );
    expect(missingPrecondition.status).toBe(412);
    const restoredResponse = await request(
      `/templates/${created.id}/versions/${current.current_version_id}/restore`,
      {
        method: "POST",
        headers: { "if-match": `"${current.current_version_id}"` },
      },
    );
    expect(restoredResponse.status).toBe(200);
    const restored = (await restoredResponse.json()) as {
      object: string;
      current_version_id: string;
    };
    expect(restored.object).toBe("template_restore");
    expect(restored.current_version_id).toMatch(/^tmplv_[a-f0-9]{32}$/);
    expect(restored.current_version_id).not.toBe(current.current_version_id);

    const otherResponse = await request("/templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Other",
        html: "<p>Other</p>",
      }),
    });
    const other = (await otherResponse.json()) as { id: string };
    const wrongTemplate = await request(
      `/templates/${other.id}/versions/${current.current_version_id}`,
      {},
      reader.token,
    );
    expect(wrongTemplate.status).toBe(404);
    const malformedVersion = await request(
      `/templates/${created.id}/versions/not-a-version`,
      {},
      reader.token,
    );
    expect(malformedVersion.status).toBe(422);
  });

  it("exposes the preview only when local preview mode is enabled", async () => {
    const regular = fixture();
    const protectedPreview = await regular.app.request("/preview");
    expect(protectedPreview.status).toBe(401);

    const { app } = previewFixture();
    const root = await app.request("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/preview");

    const preview = await app.request("/preview");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toContain("text/html");
    expect(preview.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(preview.headers.get("x-frame-options")).toBe("DENY");
    const previewHtml = await preview.text();
    expect(previewHtml).toContain("HayaSend");
    expect(previewHtml).toContain(
      'id="html-view" title="Sandboxed email HTML preview" sandbox',
    );
    expect(previewHtml).not.toContain("allow-scripts");

    const css = await app.request("/preview/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    const script = await app.request("/preview/app.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("default-src 'none'");
    const favicon = await app.request("/favicon.ico");
    expect(favicon.status).toBe(204);
  });

  it("returns body-free preview lists and isolated message details", async () => {
    const { app } = previewFixture();
    const maliciousHtml =
      '<img src="https://tracker.example/pixel"><script>parent.pwned=true</script><h1>Preview me</h1>';
    const send = await app.request("/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer re_test_secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...email,
        html: maliciousHtml,
      }),
    });
    const { id } = (await send.json()) as { id: string };

    const list = await app.request("/preview/api/emails?limit=100");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(listBody.data[0]).toMatchObject({
      id,
      subject: email.subject,
      has_html: true,
    });
    expect(listBody.data[0]).not.toHaveProperty("html");
    expect(listBody.data[0]).not.toHaveProperty("text");
    expect(listBody.data[0]).not.toHaveProperty("request_hash");

    const detail = await app.request(`/preview/api/emails/${id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as Record<string, unknown>;
    expect(detailBody).toMatchObject({
      id,
      html: maliciousHtml,
      subject: email.subject,
    });
    expect(detailBody).not.toHaveProperty("request_hash");
    expect(detail.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
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
    const { inboundStorage, receivedEmailService, request } = fixture();
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

    const retrieved = await request(`/emails/receiving/${record?.id}`);
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
    const deliveries = await request(`/webhooks/${webhookBody.id}/deliveries`);
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
    const updatedWebhook = await request(`/webhooks/${webhookBody.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        events: ["email.delivered"],
        status: "disabled",
      }),
    });
    await expect(updatedWebhook.json()).resolves.toEqual({
      object: "webhook",
      id: webhookBody.id,
    });
    const retrievedWebhook = await request(`/webhooks/${webhookBody.id}`);
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
    const retrieved = (await (await request(`/emails/${id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(retrieved.attachments).toEqual([
      {
        attachment_id: upload.id,
        filename: "invoice.txt",
        content_type: "text/plain",
      },
    ]);
    expect(JSON.stringify(retrieved)).not.toContain(content.toString("base64"));
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
    const forbiddenTemplates = await request("/templates", {}, created.token);
    expect(forbiddenTemplates.status).toBe(403);

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
