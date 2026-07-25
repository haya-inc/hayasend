import { Resend } from "resend";
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
    const webhooks = new WebhookService(store, queue);
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
    const app = createApp({
      apiKeyService: new ApiKeyService(store, "re_hayasend_compatible"),
      attachmentService: attachments,
      domainService: new DomainService(
        store,
        new LocalDomainProvider(),
        "ap-northeast-1",
      ),
      emailService: new EmailService(
        store,
        scheduler,
        passthroughTransport,
        webhooks,
        suppressions,
        attachments,
      ),
      receivedEmailService,
      suppressionService: suppressions,
      webhookService: webhooks,
    });
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const incoming = new Request(input, init);
        const url = new URL(incoming.url);
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
    expect(queue.jobs[0]?.job).toEqual({
      type: "send_email",
      email_id: data?.id,
    });

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

    const received = await resend.emails.receiving.get(
      receivedRecord.id,
      { html_format: "cid" },
    );
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

    const receivedAttachments =
      await resend.emails.receiving.attachments.list({
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
    const retrievedAttachment =
      await resend.emails.receiving.attachments.get({
        emailId: receivedRecord.id,
        id: receivedAttachment.id,
      });
    expect(retrievedAttachment.error).toBeNull();
    expect(retrievedAttachment.data).toMatchObject({
      id: receivedAttachment.id,
      filename: "sdk.txt",
    });
  });
});
