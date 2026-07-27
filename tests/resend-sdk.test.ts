import { Resend } from "resend";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryAttachmentStorage } from "../src/adapters/attachment-storage.js";
import { MemoryInboundStorage } from "../src/adapters/inbound-storage.js";
import { LocalDomainProvider } from "../src/adapters/ses-domain-provider.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { QueueEmailScheduler } from "../src/adapters/email-scheduler.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
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

const passthroughTransport: MailTransport = {
  async send(): Promise<MailTransportResult> {
    return { provider_id: "provider_id" };
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("official Resend Node SDK compatibility", () => {
  it("sends through a custom baseUrl without an SDK fork", async () => {
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
    const attachments = new AttachmentService(
      store,
      new MemoryAttachmentStorage(),
    );
    const scheduler = new QueueEmailScheduler(queue);
    const templateService = new TemplateService(store);
    const emailService = new EmailService(
      store,
      scheduler,
      passthroughTransport,
      webhooks,
      suppressions,
      attachments,
      templateService,
    );
    const app = createApp({
      apiKeyService: new ApiKeyService(store, "re_hayasend_compatible"),
      attachmentService: attachments,
      domainService: new DomainService(
        store,
        new LocalDomainProvider(),
        "ap-northeast-1",
      ),
      emailService,
      receivedEmailService,
      suppressionService: suppressions,
      templateService,
      webhookService: webhooks,
    });
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const incoming = new Request(input, init);
        const url = new URL(incoming.url);
        if (url.hostname === "local.hayasend.invalid") {
          const prefix = "/inbound/";
          if (!url.pathname.startsWith(prefix)) {
            return new Response(null, { status: 404 });
          }
          const objectKey = decodeURIComponent(
            url.pathname.slice(prefix.length),
          );
          return new Response(
            Buffer.from(await inboundStorage.readRaw(objectKey)),
            {
              headers: { "content-type": "message/rfc822" },
            },
          );
        }
        if (url.hostname !== "api.hayasend.test") {
          return nativeFetch(input, init);
        }
        const localUrl = new URL(url.pathname + url.search, "http://local");
        return app.fetch(new Request(localUrl, incoming));
      },
    );

    const resend = new Resend("re_hayasend_compatible", {
      baseUrl: "https://api.hayasend.test",
    });
    const createdWebhook = await resend.webhooks.create({
      endpoint: "https://api.hayasend.test/webhook",
      events: ["email.sent"],
    });
    expect(createdWebhook.error).toBeNull();
    expect(createdWebhook.data).toMatchObject({
      id: expect.stringMatching(/^wh_/),
      signing_secret: expect.stringMatching(/^whsec_/),
    });
    const webhookId = createdWebhook.data?.id;
    if (!webhookId) {
      throw new Error("Expected an SDK-created webhook.");
    }
    const updatedWebhook = await resend.webhooks.update(webhookId, {
      events: ["email.bounced"],
      status: "disabled",
    });
    expect(updatedWebhook).toMatchObject({
      data: { object: "webhook", id: webhookId },
      error: null,
    });
    const retrievedWebhook = await resend.webhooks.get(webhookId);
    expect(retrievedWebhook.error).toBeNull();
    expect(retrievedWebhook.data).toMatchObject({
      id: webhookId,
      endpoint: "https://api.hayasend.test/webhook",
      events: ["email.bounced"],
      status: "disabled",
    });

    const publishedTemplate = await resend.templates
      .create({
        name: "SDK welcome",
        alias: "sdk-welcome",
        from: "HayaSend <sender@example.com>",
        subject: "Welcome {{{NAME}}}",
        react: createElement(
          "p",
          null,
          "Hello {{{NAME}}}, rendered by React Email.",
        ),
        variables: [{ key: "NAME", type: "string" }],
      })
      .publish();
    expect(publishedTemplate.error).toBeNull();
    const templateId = publishedTemplate.data?.id;
    if (!templateId) {
      throw new Error("Expected an SDK-created template.");
    }
    const templateEmail = await resend.emails.send({
      to: "template-recipient@example.net",
      template: {
        id: "sdk-welcome",
        variables: { NAME: "Ada" },
      },
    });
    expect(templateEmail.error).toBeNull();
    const storedTemplateEmail = await store.getEmail(
      templateEmail.data?.id ?? "",
    );
    expect(storedTemplateEmail).toMatchObject({
      from: "HayaSend <sender@example.com>",
      subject: "Welcome Ada",
    });
    expect(storedTemplateEmail?.html).toContain(
      "Hello Ada, rendered by React Email.",
    );
    expect(storedTemplateEmail?.text).toContain(
      "Hello Ada, rendered by React Email.",
    );
    const template = await resend.templates.get("sdk-welcome");
    expect(template.error).toBeNull();
    expect(template.data).toMatchObject({
      object: "template",
      id: templateId,
      alias: "sdk-welcome",
      status: "published",
      has_unpublished_versions: false,
    });
    const templates = await resend.templates.list();
    expect(templates.error).toBeNull();
    expect(templates.data?.data).toEqual([
      expect.objectContaining({ id: templateId, alias: "sdk-welcome" }),
    ]);
    await expect(
      resend.templates.list({ limit: 1, after: templateId }),
    ).resolves.toMatchObject({
      data: { object: "list", data: [], has_more: false },
      error: null,
    });
    await expect(
      resend.templates.list({ limit: 1, before: templateId }),
    ).resolves.toMatchObject({
      data: { object: "list", data: [], has_more: false },
      error: null,
    });
    const updatedTemplate = await resend.templates.update("sdk-welcome", {
      subject: "Updated {{{NAME}}}",
      replyTo: "updated-support@example.com",
    });
    expect(updatedTemplate).toMatchObject({
      data: { object: "template", id: templateId },
      error: null,
    });
    const draftTemplate = await resend.templates.get(templateId);
    expect(draftTemplate.data).toMatchObject({
      subject: "Updated {{{NAME}}}",
      reply_to: ["updated-support@example.com"],
      has_unpublished_versions: true,
    });
    const stillPublishedEmail = await resend.emails.send({
      to: "stable-version@example.net",
      template: {
        id: templateId,
        variables: { NAME: "Grace" },
      },
    });
    const storedStableEmail = await store.getEmail(
      stillPublishedEmail.data?.id ?? "",
    );
    expect(storedStableEmail).toMatchObject({
      subject: "Welcome Grace",
    });
    expect(storedStableEmail?.reply_to).toBeUndefined();

    const republished = await resend.templates.publish(templateId);
    expect(republished.error).toBeNull();
    const updatedEmail = await resend.emails.send({
      to: "updated-version@example.net",
      template: {
        id: "sdk-welcome",
        variables: { NAME: "Lin" },
      },
    });
    await expect(
      store.getEmail(updatedEmail.data?.id ?? ""),
    ).resolves.toMatchObject({
      subject: "Updated Lin",
      reply_to: ["updated-support@example.com"],
    });
    const templateBatch = await resend.batch.send([
      {
        to: "batch-template@example.net",
        template: {
          id: templateId,
          variables: { NAME: "Katherine" },
        },
      },
    ]);
    expect(templateBatch.error).toBeNull();
    await expect(
      store.getEmail(templateBatch.data?.data[0]?.id ?? ""),
    ).resolves.toMatchObject({
      subject: "Updated Katherine",
      reply_to: ["updated-support@example.com"],
    });

    const duplicatedTemplate = await resend.templates.duplicate(templateId);
    expect(duplicatedTemplate.error).toBeNull();
    const duplicateId = duplicatedTemplate.data?.id;
    if (!duplicateId) {
      throw new Error("Expected an SDK-duplicated template.");
    }
    await expect(resend.templates.get(duplicateId)).resolves.toMatchObject({
      data: {
        id: duplicateId,
        name: "SDK welcome copy",
        alias: null,
        status: "draft",
      },
      error: null,
    });
    await expect(resend.templates.remove(duplicateId)).resolves.toMatchObject({
      data: {
        object: "template",
        id: duplicateId,
        deleted: true,
      },
      error: null,
    });

    const { data, error } = await resend.emails.send({
      from: "HayaSend <sender@example.com>",
      to: "recipient@example.net",
      subject: "Official SDK compatibility",
      text: "No SDK fork required.",
      replyTo: "support@example.com",
      tags: [{ name: "source", value: "resend-sdk-test" }],
    });

    expect(error).toBeNull();
    expect(data?.id).toMatch(/^email_/);
    expect(queue.jobs.map(({ job }) => job)).toContainEqual({
      type: "reconcile_outbox",
      outbox_id: `outbox:v1:${data?.id}:dispatch-message:0`,
    });
    if (!data?.id) {
      throw new Error("Expected an SDK-created email.");
    }
    await expect(
      resend.webhooks.update(webhookId, {
        events: ["email.sent"],
        status: "enabled",
      }),
    ).resolves.toMatchObject({
      data: { object: "webhook", id: webhookId },
      error: null,
    });
    await emailService.processSend(data.id);
    const accepted = await resend.emails.get(data.id);
    expect(accepted.error).toBeNull();
    expect(accepted.data?.id).toBe(data.id);
    expect(accepted.data?.message_id).toBe("provider_id");
    const acceptedList = await resend.emails.list({ limit: 100 });
    expect(acceptedList.error).toBeNull();
    expect(
      acceptedList.data?.data.find((item) => item.id === data.id),
    ).toMatchObject({
      id: data.id,
      message_id: "provider_id",
    });
    expect(
      queue.jobs
        .map(({ job }) => job)
        .find(
          (job) =>
            job.type === "deliver_webhook" && job.event.type === "email.sent",
        ),
    ).toMatchObject({
      event: {
        data: {
          email_id: data.id,
          message_id: "provider_id",
        },
      },
    });
    const firstEmailPage = await resend.emails.list({ limit: 1 });
    expect(firstEmailPage.error).toBeNull();
    expect(firstEmailPage.data).toMatchObject({
      object: "list",
      has_more: true,
      next_cursor: firstEmailPage.data?.data[0]?.id,
    });
    const emailCursor = firstEmailPage.data?.data[0]?.id;
    if (!emailCursor) {
      throw new Error("Expected an SDK email-list cursor.");
    }
    const secondEmailPage = await resend.emails.list({
      limit: 1,
      after: emailCursor,
    });
    expect(secondEmailPage.error).toBeNull();
    expect(secondEmailPage.data?.data).toHaveLength(1);
    expect(secondEmailPage.data?.data[0]?.id).not.toBe(emailCursor);

    const htmlOnly = await resend.emails.send({
      from: "HayaSend <sender@example.com>",
      to: "html-only@example.net",
      subject: "SDK plain-text fallback",
      html: "<h1>Hello</h1><p>Derived through the Node SDK.</p>",
    });
    expect(htmlOnly.error).toBeNull();
    await expect(
      store.getEmail(htmlOnly.data?.id ?? ""),
    ).resolves.toMatchObject({
      text: expect.stringContaining("Derived through the Node SDK."),
    });

    const optedOutBatch = await resend.batch.send([
      {
        from: "HayaSend <sender@example.com>",
        to: "html-only-batch@example.net",
        subject: "SDK plain-text opt-out",
        html: "<p>HTML only through the Node SDK.</p>",
        text: "",
      },
    ]);
    expect(optedOutBatch.error).toBeNull();
    await expect(
      store.getEmail(optedOutBatch.data?.data[0]?.id ?? ""),
    ).resolves.toMatchObject({ text: "" });

    inboundStorage.seedRaw(
      "inbound/raw/sdk-inbound-1",
      [
        "From: SDK Sender <sender@example.com>",
        "To: sdk@inbound.example.net",
        "Message-ID: <sdk-inbound@example.com>",
        "Subject: SDK inbound compatibility",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="sdk"',
        "",
        "--sdk",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Received through the SDK.",
        "--sdk",
        'Content-Type: text/plain; name="sdk.txt"',
        'Content-Disposition: attachment; filename="sdk.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("sdk attachment").toString("base64"),
        "--sdk--",
        "",
      ].join("\r\n"),
    );
    const receivedRecord = await receivedEmailService.ingest({
      provider_message_id: "sdk-inbound-1",
      source: "sender@example.com",
      destinations: ["sdk@inbound.example.net"],
      timestamp: "2026-07-26T08:00:00.000Z",
      verdicts: {},
    });
    if (!receivedRecord) {
      throw new Error("Expected a received email record.");
    }

    const receivedList = await resend.emails.receiving.list();
    expect(receivedList.error).toBeNull();
    expect(receivedList.data?.data[0]).toMatchObject({
      id: receivedRecord.id,
      received_for: ["sdk@inbound.example.net"],
      subject: "SDK inbound compatibility",
    });

    const received = await resend.emails.receiving.get(receivedRecord.id, {
      html_format: "cid",
    });
    expect(received.error).toBeNull();
    expect(received.data).toMatchObject({
      id: receivedRecord.id,
      html_format: "cid",
      text: expect.stringContaining("Received through the SDK."),
      raw: {
        download_url: expect.stringContaining(
          "https://local.hayasend.invalid/inbound/",
        ),
      },
    });

    const receivedAttachments = await resend.emails.receiving.attachments.list({
      emailId: receivedRecord.id,
    });
    expect(receivedAttachments.error).toBeNull();
    const receivedAttachment = receivedAttachments.data?.data[0];
    expect(receivedAttachment).toMatchObject({
      filename: "sdk.txt",
      size: 14,
      content_disposition: "attachment",
      download_url: expect.stringContaining(
        "https://local.hayasend.invalid/inbound/",
      ),
    });
    if (!receivedAttachment) {
      throw new Error("Expected a received attachment.");
    }
    const retrievedAttachment = await resend.emails.receiving.attachments.get({
      emailId: receivedRecord.id,
      id: receivedAttachment.id,
    });
    expect(retrievedAttachment.error).toBeNull();
    expect(retrievedAttachment.data).toMatchObject({
      id: receivedAttachment.id,
      filename: "sdk.txt",
    });

    const forwarded = await resend.emails.receiving.forward(
      {
        emailId: receivedRecord.id,
        from: "HayaSend Forwarder <forwarder@example.com>",
        to: "archive@example.net",
      },
      { idempotencyKey: `forward-${receivedRecord.id}` },
    );
    expect(forwarded.error).toBeNull();
    expect(forwarded.data?.id).toMatch(/^email_/);
    const forwardedEmail = await store.getEmail(forwarded.data?.id ?? "");
    expect(forwardedEmail).toMatchObject({
      from: "HayaSend Forwarder <forwarder@example.com>",
      to: ["archive@example.net"],
      subject: "SDK inbound compatibility",
      text: expect.stringContaining("Received through the SDK."),
      attachments: [
        {
          filename: "sdk.txt",
          content_type: "text/plain",
          content: Buffer.from("sdk attachment").toString("base64"),
        },
      ],
    });
    expect(queue.jobs.at(-1)?.job).toEqual({
      type: "reconcile_outbox",
      outbox_id: `outbox:v1:${forwarded.data?.id}:dispatch-message:0`,
    });
  });
});
