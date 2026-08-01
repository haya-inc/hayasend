import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppOptions } from "../src/app.js";
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
import { RecoveryDiagnosticsService } from "../src/services/recovery-diagnostics-service.js";
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

function fixture(options: AppOptions = {}) {
  const store = new MemoryStore();
  const queue = new CapturingJobQueue();
  const webhooks = new WebhookService(store, queue, {
    httpFetch: fetch,
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
  const recoveryDiagnostics = new RecoveryDiagnosticsService(
    store,
    queue,
    {
      provider: "local-console",
      adapter_version: "0.3.5",
      capability_version: "1.0.0",
      checked_at: null,
      document: {
        provider: "local-console",
        adapter_version: "0.3.5",
      },
    },
  );
  const app = createApp(
    {
      apiKeyService: apiKeys,
      attachmentService: attachments,
      domainService: domains,
      emailService: emails,
      receivedEmailService,
      recoveryDiagnosticsService: recoveryDiagnostics,
      suppressionService: suppressions,
      templateService: templates,
      webhookService: webhooks,
    },
    options,
  );
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
    recoveryDiagnostics,
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
        recoveryDiagnosticsService: result.recoveryDiagnostics,
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
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ok: true });

    const unauthorized = await request("/emails", {}, "wrong");
    expect(unauthorized.status).toBe(401);
  });

  it("serves a public console shell while keeping session and data routes authenticated", async () => {
    const { app, request } = fixture();

    const consolePage = await app.request("/console");
    expect(consolePage.status).toBe(200);
    expect(consolePage.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(consolePage.headers.get("content-security-policy")).toContain(
      "form-action 'none'",
    );
    expect(consolePage.headers.get("x-frame-options")).toBe("DENY");
    expect(await consolePage.text()).toContain("Operator Console · HayaSend");

    const script = await app.request("/console/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain(
      "text/javascript",
    );

    const anonymousSession = await app.request("/auth/session");
    expect(anonymousSession.status).toBe(401);

    const session = await request("/auth/session");
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({
      object: "authenticated_session",
      principal: {
        id: "bootstrap",
        name: "Bootstrap administrator",
        scopes: ["*"],
        bootstrap: true,
      },
    });
  });

  it("protects Azure Event Grid ingress with an independent secret and returns validation", async () => {
    const receive = vi.fn(async () => ({
      validation_response: "validation-code",
    }));
    const { app } = fixture({
      providerEventIngress: {
        secret: "event-grid-secret-that-is-independent",
        ingress: { receive },
      },
    });
    const body = JSON.stringify([{ eventType: "validation" }]);
    const unauthorized = await app.request("/events/azure-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unauthorized.status).toBe(401);
    const wrong = await app.request("/events/azure-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hayasend-event-grid-secret": "wrong",
      },
      body,
    });
    expect(wrong.status).toBe(401);
    const accepted = await app.request("/events/azure-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hayasend-event-grid-secret":
          "event-grid-secret-that-is-independent",
      },
      body,
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      validationResponse: "validation-code",
    });
    expect(receive).toHaveBeenCalledWith(
      [{ eventType: "validation" }],
      {
        received_at: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
      },
    );
  });

  it("passes exact raw bytes and SendGrid signature headers to public ingress", async () => {
    const receive = vi.fn(async () => undefined);
    const { app } = fixture({
      sendGridEventIngress: { receive },
    });
    const body =
      '[{"event":"delivered","opaque":"\\u003cunchanged\\u003e"}]';
    const response = await app.request("/events/sendgrid", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twilio-email-event-webhook-signature": "signed-value",
        "x-twilio-email-event-webhook-timestamp": "1785283500",
      },
      body,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(receive).toHaveBeenCalledWith(
      new TextEncoder().encode(body),
      {
        signature: "signed-value",
        timestamp: "1785283500",
        received_at: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        ),
      },
    );
  });

  it("reports readiness failures without exposing private diagnostics", async () => {
    const result = fixture();
    const app = createApp(
      {
        apiKeyService: result.apiKeys,
        attachmentService: result.attachments,
        domainService: result.domains,
        emailService: result.emails,
        receivedEmailService: result.receivedEmailService,
        recoveryDiagnosticsService: result.recoveryDiagnostics,
        suppressionService: result.suppressions,
        templateService: result.templates,
        webhookService: result.webhooks,
      },
      {
        readiness: async () => {
          throw new Error("postgres://private:secret@database.invalid");
        },
      },
    );

    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('"ok":false');
    expect(body).not.toContain("private");
    expect(body).not.toContain("secret");
  });

  it.each([
    ["POST", "/attachments"],
    ["POST", "/domains"],
    ["POST", "/api-keys"],
    ["POST", "/suppressions"],
    ["POST", "/templates"],
    ["POST", "/webhooks"],
    ["PATCH", "/webhooks/wh_missing"],
  ])(
    "returns a public validation error for malformed JSON on %s %s",
    async (method, path) => {
      const { request } = fixture();
      const response = await request(path, {
        method,
        body: "\u0000",
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        statusCode: 422,
        name: "validation_error",
        message: "Malformed JSON in request body",
      });
    },
  );

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
        job: {
          type: "reconcile_outbox",
          outbox_id: `outbox:v1:${body.id}:dispatch-message:0`,
        },
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

  it("[conformance:recovery-diagnostics-privacy] exposes privacy-safe recipient truth with explicit pagination and authorization", async () => {
    const { emails, request } = fixture();
    const firstAddress = "first-private@example.net";
    const secondAddress = "second-private@example.net";
    const created = await request("/emails", {
      method: "POST",
      body: JSON.stringify({
        ...email,
        to: [firstAddress, secondAddress],
        subject: "Private mixed outcome",
      }),
    });
    const { id } = (await created.json()) as { id: string };
    await emails.processSend(id);
    await emails.applyProviderEvent(id, "email.bounced", {
      provider_event_id: "mixed-bounce",
      provider_message_id: `provider_${id}`,
      provider_at: "2026-07-27T00:00:01.000Z",
      received_at: "2026-07-27T00:00:02.000Z",
      recipient_addresses: [firstAddress],
    });
    await emails.applyProviderEvent(id, "email.delivered", {
      provider_event_id: "mixed-delivery",
      provider_message_id: `provider_${id}`,
      provider_at: "2026-07-27T00:00:03.000Z",
      received_at: "2026-07-27T00:00:04.000Z",
      recipient_addresses: [secondAddress],
    });

    const readerResponse = await request("/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: "recipient reader",
        scopes: ["emails:read"],
      }),
    });
    const reader = (await readerResponse.json()) as { token: string };
    const firstPageResponse = await request(
      `/emails/${id}/recipients?limit=1`,
      {},
      reader.token,
    );
    expect(firstPageResponse.status).toBe(200);
    const firstPageText = await firstPageResponse.text();
    expect(firstPageText).not.toContain(firstAddress);
    expect(firstPageText).not.toContain(secondAddress);
    expect(firstPageText).not.toContain("Private mixed outcome");
    expect(firstPageText).not.toContain(`provider_${id}`);
    const firstPage = JSON.parse(firstPageText) as {
      aggregate_status: string;
      data: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string;
    };
    expect(firstPage).toMatchObject({
      object: "list",
      message_id: id,
      aggregate_status: "partially_delivered",
      recipient_count: 2,
      has_more: true,
      attempt_summary: { accepted: 1 },
      data: [
        {
          role: "to",
          ordinal: 0,
          status: "bounced",
          recovery_state: "settled",
          requires_operator_attention: true,
        },
      ],
    });
    const secondPage = await request(
      `/emails/${id}/recipients?limit=1&after=${encodeURIComponent(
        firstPage.next_cursor,
      )}`,
      {},
      reader.token,
    );
    await expect(secondPage.json()).resolves.toMatchObject({
      has_more: false,
      data: [
        {
          role: "to",
          ordinal: 1,
          status: "delivered",
          recovery_state: "settled",
          requires_operator_attention: false,
        },
      ],
    });
    const invalidCursor = await request(
      `/emails/${id}/recipients?after=rcpt_missing`,
      {},
      reader.token,
    );
    expect(invalidCursor.status).toBe(422);

    const diagnosticsWithEmailScope = await request(
      "/diagnostics/recovery",
      {},
      reader.token,
    );
    expect(diagnosticsWithEmailScope.status).toBe(403);
    const diagnosticsKeyResponse = await request("/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: "recovery reader",
        scopes: ["diagnostics:read"],
      }),
    });
    const diagnosticsKey = (await diagnosticsKeyResponse.json()) as {
      token: string;
    };
    const diagnostics = await request(
      "/diagnostics/recovery",
      {},
      diagnosticsKey.token,
    );
    expect(diagnostics.status).toBe(200);
    const diagnosticsText = await diagnostics.text();
    expect(diagnosticsText).not.toContain(firstAddress);
    expect(diagnosticsText).not.toContain(secondAddress);
    expect(diagnosticsText).not.toContain("Private mixed outcome");
    await expect(
      Promise.resolve(JSON.parse(diagnosticsText)),
    ).resolves.toMatchObject({
      object: "recovery_diagnostics",
      queues: {
        provider: "memory",
      },
      provider_events: {
        latest_received_at: "2026-07-27T00:00:04.000Z",
      },
      capability: {
        provider: "local-console",
      },
    });
  });

  it("exposes the provider Message-ID only after acceptance", async () => {
    const { emails, request } = fixture();
    const response = await request("/emails", {
      method: "POST",
      body: JSON.stringify(email),
    });
    const { id } = (await response.json()) as { id: string };

    const queued = (await (await request(`/emails/${id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(queued).not.toHaveProperty("message_id");

    await emails.processSend(id);

    await expect(
      (await request(`/emails/${id}`)).json(),
    ).resolves.toMatchObject({
      id,
      provider_id: `provider_${id}`,
      message_id: `provider_${id}`,
    });
    await expect((await request("/emails")).json()).resolves.toMatchObject({
      data: [
        {
          id,
          message_id: `provider_${id}`,
        },
      ],
    });
  });

  it("lists lightweight email summaries without transferring stored content", async () => {
    const { request } = fixture();
    const created = await request("/emails", {
      method: "POST",
      body: JSON.stringify({
        ...email,
        html: "<p>private-list-body</p>",
        text: "private-list-text",
        headers: { "x-private-list-header": "private-list-value" },
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const response = await request("/emails?limit=100&view=summary");
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain("private-list-body");
    expect(responseText).not.toContain("private-list-text");
    expect(responseText).not.toContain("private-list-header");
    expect(responseText).not.toContain("private-list-value");
    expect(JSON.parse(responseText)).toMatchObject({
      object: "list",
      data: [
        {
          id,
          subject: "Hello",
          has_html: true,
          has_text: true,
          attachment_count: 0,
        },
      ],
    });
  });

  it("returns a stable validation error for an unknown list cursor", async () => {
    const { request } = fixture();
    const response = await request("/emails?after=email_missing");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      statusCode: 422,
      name: "validation_error",
      message: "The pagination cursor is invalid.",
    });
  });

  it("matches direct-send text fallback and empty-string opt-out semantics", async () => {
    const { request } = fixture();
    const derivedResponse = await request("/emails", {
      method: "POST",
      body: JSON.stringify({
        ...email,
        text: undefined,
        html: "<h1>Hello</h1><p>Derived by HayaSend.</p>",
      }),
    });
    expect(derivedResponse.status).toBe(200);
    const derivedId = ((await derivedResponse.json()) as { id: string }).id;
    const derived = (await (
      await request(`/emails/${derivedId}`)
    ).json()) as Record<string, unknown>;
    expect(derived.text).toEqual(expect.stringContaining("HELLO"));
    expect(derived.text).toEqual(
      expect.stringContaining("Derived by HayaSend."),
    );

    const optedOutResponse = await request("/emails", {
      method: "POST",
      body: JSON.stringify({
        ...email,
        text: "",
        html: "<p>HTML only</p>",
      }),
    });
    expect(optedOutResponse.status).toBe(200);
    const optedOutId = ((await optedOutResponse.json()) as { id: string }).id;
    await expect(
      (await request(`/emails/${optedOutId}`)).json(),
    ).resolves.toMatchObject({ text: "" });

    const emptyResponse = await request("/emails", {
      method: "POST",
      body: JSON.stringify({ ...email, text: "", html: undefined }),
    });
    expect(emptyResponse.status).toBe(422);
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

  it("replays identical idempotent requests with the same id and a repair job", async () => {
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
    expect(queue.jobs).toHaveLength(2);

    const conflict = await request("/emails", {
      ...init,
      body: JSON.stringify({ ...email, subject: "Changed" }),
    });
    expect(conflict.status).toBe(409);
  });

  it.each(["", "x".repeat(257)])(
    "rejects an out-of-contract idempotency key",
    async (idempotencyKey) => {
      const { request } = fixture();
      for (const path of ["/emails", "/emails/batch"]) {
        const response = await request(path, {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body: JSON.stringify(path.endsWith("/batch") ? [email] : email),
        });

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({
          name: "validation_error",
          message:
            "Idempotency-Key must contain between 1 and 256 characters.",
        });
      }
    },
  );

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
    const domainBody = (await domain.json()) as { id: string };
    expect(domainBody).toMatchObject({
      id: expect.stringMatching(/^dom_/),
      name: "example.com",
      status: "verified",
    });

    const duplicateDomain = await request("/domains", {
      method: "POST",
      body: JSON.stringify({ name: "EXAMPLE.COM." }),
    });
    expect(duplicateDomain.status).toBe(403);
    await expect(duplicateDomain.json()).resolves.toEqual({
      statusCode: 403,
      name: "validation_error",
      message: "The `example.com` domain has been registered already.",
    });

    const deletedDomain = await request(`/domains/${domainBody.id}`, {
      method: "DELETE",
    });
    expect(deletedDomain.status).toBe(200);
    const recreatedDomain = await request("/domains", {
      method: "POST",
      body: JSON.stringify({ name: "example.com" }),
    });
    expect(recreatedDomain.status).toBe(200);

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

  it("rejects a strict batch before accepting any valid sibling", async () => {
    const { queue, request, store } = fixture();
    const response = await request("/emails/batch", {
      method: "POST",
      body: JSON.stringify([
        email,
        {
          to: "template-recipient@example.net",
          template: { id: "missing-template" },
        },
      ]),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      name: "not_found",
      message: "Template was not found.",
    });
    await expect(store.listEmails(100)).resolves.toMatchObject({ data: [] });
    expect(queue.jobs).toHaveLength(0);
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

  it("does not double-decode percent-containing suppression paths", async () => {
    const { request } = fixture();
    const emailAddress = "percent%@example.net";
    const path = `/suppressions/${encodeURIComponent(emailAddress)}`;
    for (const method of ["GET", "DELETE"]) {
      const response = await request(path, { method });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        name: "not_found",
      });
    }
  });

  it("returns the email key when deleting a suppression", async () => {
    const { request } = fixture();
    const emailAddress = "blocked+tag@example.net";
    const created = await request("/suppressions", {
      method: "POST",
      body: JSON.stringify({
        email: emailAddress,
        reason: "manual",
      }),
    });
    expect(created.status).toBe(200);

    const path = `/suppressions/${encodeURIComponent(emailAddress)}`;
    const deleted = await request(path, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({
      object: "suppression",
      email: emailAddress,
      deleted: true,
    });
  });

  it("uses an internal request ID and logs no untrusted error details", async () => {
    const result = fixture();
    const sensitive =
      "recipient@example.net-re_secret_token-private-subject";
    vi.spyOn(result.emails, "get").mockRejectedValueOnce(
      new Error(sensitive),
    );
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const response = await result.request(
        `/emails/${encodeURIComponent(sensitive)}`,
        { headers: { "x-request-id": sensitive } },
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(response.headers.get("x-request-id")).not.toBe(sensitive);
      const logged = errors.mock.calls.flat().join(" ");
      expect(logged).toContain('"message":"API request failed"');
      expect(logged).toContain('"error_type":"application_error"');
      expect(logged).not.toContain(sensitive);

      errors.mockClear();
      const invalid = await result.request("/emails", {
        method: "POST",
        body: "{}",
      });
      expect(invalid.status).toBe(422);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
