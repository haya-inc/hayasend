import { describe, expect, it } from "vitest";
import { MemoryInboundStorage } from "../src/adapters/inbound-storage.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import type { InboundEmailEvent } from "../src/core/types.js";
import { ReceivedEmailService } from "../src/services/received-email-service.js";
import { WebhookService } from "../src/services/webhook-service.js";

const rawEmail = [
  "From: Acme Support <support@example.com>",
  "To: Customer <customer@example.net>",
  "Cc: Observer <observer@example.net>",
  "Reply-To: Help Desk <help@example.com>",
  "Message-ID: <thread-42@example.com>",
  "Subject: Inbound test",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Plain body",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>HTML body</p>",
  "--inner--",
  "--outer",
  'Content-Type: text/plain; name="notes.txt"',
  "Content-Disposition: attachment; filename=\"notes.txt\"",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("private notes").toString("base64"),
  "--outer--",
  "",
].join("\r\n");

const event: InboundEmailEvent = {
  provider_message_id: "aws-message-42",
  source: "support@example.com",
  destinations: [
    "customer@example.net",
    "observer@example.net",
    "hidden@example.net",
  ],
  timestamp: "2026-07-26T08:00:00.000Z",
  verdicts: {
    spam: "PASS",
    virus: "PASS",
    spf: "PASS",
    dkim: "PASS",
    dmarc: "PASS",
  },
};

function fixture(maxMessageBytes = 25 * 1024 * 1024) {
  const store = new MemoryStore();
  const storage = new MemoryInboundStorage();
  const queue = new CapturingJobQueue();
  const webhooks = new WebhookService(store, queue);
  const service = new ReceivedEmailService(
    store,
    storage,
    queue,
    webhooks,
    {
      rawPrefix: "inbound/raw/",
      retentionDays: 7,
      maxMessageBytes,
    },
  );
  storage.seedRaw("inbound/raw/aws-message-42", rawEmail);
  return { queue, service, storage, store, webhooks };
}

describe("ReceivedEmailService", () => {
  it("parses, stores, retrieves, and publishes a Resend-shaped event", async () => {
    const { queue, service, webhooks } = fixture();
    await webhooks.create({
      endpoint: "https://example.com/inbound",
      events: ["email.received"],
    });

    const first = await service.ingest(event);
    const duplicate = await service.ingest(event);

    expect(first?.id).toMatch(/^recv_[a-f0-9]{32}$/);
    expect(duplicate?.id).toBe(first?.id);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.job).toEqual({
      type: "publish_received_email",
      email_id: first?.id,
    });

    const page = await service.list(20);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      object: "email",
      from: "Acme Support <support@example.com>",
      to: ["Customer <customer@example.net>"],
      received_for: [
        "customer@example.net",
        "observer@example.net",
        "hidden@example.net",
      ],
      cc: ["Observer <observer@example.net>"],
      bcc: ["hidden@example.net"],
      message_id: "<thread-42@example.com>",
      subject: "Inbound test",
      attachments: [
        {
          id: expect.stringMatching(/^att_[a-f0-9]{32}$/),
          filename: "notes.txt",
          size: 13,
          content_type: "text/plain",
        },
      ],
    });

    const received = await service.get(first?.id ?? "");
    expect(received).toMatchObject({
      html: expect.stringContaining("<p>HTML body</p>"),
      html_format: "data_uri",
      text: expect.stringContaining("Plain body"),
      raw: {
        download_url: expect.stringContaining(
          "https://local.hayasend.invalid/inbound/",
        ),
        expires_at: expect.any(String),
      },
    });
    expect(received.headers).toMatchObject({
      from: "Acme Support <support@example.com>",
      subject: "Inbound test",
    });

    const attachments = await service.listAttachments(first?.id ?? "");
    expect(attachments.data).toHaveLength(1);
    expect(attachments.data[0]).toMatchObject({
      download_url: expect.stringContaining(
        "https://local.hayasend.invalid/inbound/",
      ),
      expires_at: expect.any(String),
    });
    const attachment = await service.getAttachment(
      first?.id ?? "",
      attachments.data[0]?.id ?? "",
    );
    expect(attachment).toMatchObject({
      object: "attachment",
      filename: "notes.txt",
      size: 13,
      download_url: expect.stringContaining(
        "https://local.hayasend.invalid/inbound/",
      ),
    });

    await service.publishWebhook(first?.id ?? "");
    expect(queue.jobs).toHaveLength(2);
    const delivery = queue.jobs[1]?.job;
    expect(delivery?.type).toBe("deliver_webhook");
    if (!delivery || delivery.type !== "deliver_webhook") {
      throw new Error("Expected a webhook delivery job.");
    }
    expect(delivery.event).toMatchObject({
      type: "email.received",
      data: {
        email_id: first?.id,
        from: "Acme Support <support@example.com>",
        to: ["Customer <customer@example.net>"],
        received_for: [
          "customer@example.net",
          "observer@example.net",
          "hidden@example.net",
        ],
        bcc: ["hidden@example.net"],
        cc: ["Observer <observer@example.net>"],
        message_id: "<thread-42@example.com>",
        attachments: [
          {
            filename: "notes.txt",
            content_type: "text/plain",
          },
        ],
      },
    });
    expect(delivery.event.data).not.toHaveProperty("html");
    expect(delivery.event.data).not.toHaveProperty("text");
  });

  it("serves inline content IDs as CID references or bounded data URIs", async () => {
    const { service, storage } = fixture();
    storage.seedRaw(
      "inbound/raw/aws-message-42",
      [
        "From: Inline Sender <support@example.com>",
        "To: customer@example.net",
        "Subject: Inline image",
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="inline"',
        "",
        "--inline",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Logo</p><img src="cid:logo%40example.com">',
        "--inline",
        "Content-Type: image/png",
        "Content-Disposition: inline",
        "Content-ID: <logo@example.com>",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        "--inline--",
        "",
      ].join("\r\n"),
    );
    const record = await service.ingest(event);

    const cid = await service.get(record?.id ?? "", "cid");
    expect(cid).toMatchObject({
      html_format: "cid",
      html: expect.stringContaining("cid:logo%40example.com"),
    });

    const dataUri = await service.get(record?.id ?? "", "data_uri");
    expect(dataUri).toMatchObject({
      html_format: "data_uri",
      html: expect.stringContaining("data:image/png;base64,iVBORw=="),
    });
  });

  it("rejects unsafe message IDs and messages above the configured limit", async () => {
    const unsafe = fixture();
    await expect(
      unsafe.service.ingest({
        ...event,
        provider_message_id: "invalid\nmessage-id",
      }),
    ).rejects.toMatchObject({ name: "validation_error" });

    const oversized = fixture(32);
    await expect(oversized.service.ingest(event)).rejects.toMatchObject({
      name: "validation_error",
    });
    await expect(oversized.service.ingest(event)).rejects.toMatchObject({
      name: "validation_error",
    });
  });
});
