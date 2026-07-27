import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.js";
import type {
  EmailRecord,
  ReceivedEmailRecord,
  WebhookDeliveryRecord,
} from "../src/core/types.js";

function emailRecord(id: string, createdAt: string): EmailRecord {
  return {
    id,
    from: "sender@example.com",
    to: ["recipient@example.net"],
    subject: id,
    text: "Body",
    status: "sent",
    last_event: "sent",
    created_at: createdAt,
    updated_at: createdAt,
    request_hash: `hash-${id}`,
    attempts: 1,
  };
}

function receivedRecord(
  id: string,
  createdAt: string,
  expiresAt: string,
): ReceivedEmailRecord {
  return {
    id,
    provider_message_id: `provider-${id}`,
    message_id: `<${id}@example.com>`,
    from: "sender@example.com",
    to: ["recipient@example.net"],
    received_for: ["recipient@example.net"],
    bcc: [],
    cc: [],
    reply_to: [],
    subject: id,
    created_at: createdAt,
    raw_object_key: `inbound/raw/${id}`,
    content_object_key: `inbound/content/${id}.json`,
    attachments: [],
    content_truncated: false,
    expires_at: expiresAt,
  };
}

function deliveryRecord(id: string, webhookId: string): WebhookDeliveryRecord {
  return {
    id,
    webhook_id: webhookId,
    event_type: "email.sent",
    event: {
      type: "email.sent",
      created_at: "2099-01-01T00:00:00.000Z",
      data: {
        created_at: "2099-01-01T00:00:00.000Z",
        email_id: "email_123",
        from: "sender@example.com",
        to: ["recipient@example.net"],
        subject: "Subject",
      },
    },
    status: "pending",
    attempts: 0,
    created_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
    expires_at: "2099-01-08T00:00:00.000Z",
  };
}

describe("resource-ID pagination", () => {
  it("continues after the last returned ID when a newer record is inserted", async () => {
    const store = new MemoryStore();
    await store.createEmail(
      emailRecord("email_oldest", "2030-01-01T00:00:00.000Z"),
    );
    await store.createEmail(
      emailRecord("email_older", "2030-01-02T00:00:00.000Z"),
    );
    await store.createEmail(
      emailRecord("email_cursor", "2030-01-03T00:00:00.000Z"),
    );

    const first = await store.listEmails(1);
    expect(first).toMatchObject({
      data: [{ id: "email_cursor" }],
      has_more: true,
      next_cursor: "email_cursor",
    });

    await store.createEmail(
      emailRecord("email_newly_inserted", "2030-01-04T00:00:00.000Z"),
    );
    const second = await store.listEmails(1, first.next_cursor);
    expect(second).toMatchObject({
      data: [{ id: "email_older" }],
      has_more: true,
      next_cursor: "email_older",
    });
    await expect(
      store.listEmails(10, second.next_cursor),
    ).resolves.toMatchObject({
      data: [{ id: "email_oldest" }],
      has_more: false,
    });
  });

  it("uses the resource ID as a deterministic tie-breaker", async () => {
    const store = new MemoryStore();
    const createdAt = "2030-01-01T00:00:00.000Z";
    await store.createEmail(emailRecord("email_a", createdAt));
    await store.createEmail(emailRecord("email_c", createdAt));
    await store.createEmail(emailRecord("email_b", createdAt));

    const first = await store.listEmails(2);
    expect(first).toMatchObject({
      data: [{ id: "email_c" }, { id: "email_b" }],
      has_more: true,
      next_cursor: "email_b",
    });
    await expect(
      store.listEmails(2, first.next_cursor),
    ).resolves.toMatchObject({
      data: [{ id: "email_a" }],
      has_more: false,
    });
  });

  it("rejects a missing cursor instead of silently restarting the list", async () => {
    const store = new MemoryStore();
    await expect(store.listEmails(20, "email_missing")).rejects.toMatchObject({
      name: "validation_error",
      message: "The pagination cursor is invalid.",
    });
  });

  it("keeps expired receiving records out of pages and cursor anchors", async () => {
    const store = new MemoryStore();
    await store.createReceivedEmail(
      receivedRecord(
        "recv_expired",
        "2020-01-01T00:00:00.000Z",
        "2020-01-08T00:00:00.000Z",
      ),
    );
    await store.createReceivedEmail(
      receivedRecord(
        "recv_active",
        "2099-01-01T00:00:00.000Z",
        "2099-01-08T00:00:00.000Z",
      ),
    );

    await expect(store.listReceivedEmails(20)).resolves.toMatchObject({
      data: [{ id: "recv_active" }],
      has_more: false,
    });
    await expect(
      store.listReceivedEmails(20, "recv_expired"),
    ).rejects.toMatchObject({
      name: "validation_error",
    });
  });

  it("rejects a webhook-delivery cursor from another webhook", async () => {
    const store = new MemoryStore();
    await store.createWebhookDelivery(deliveryRecord("msg_a", "wh_a"));
    await store.createWebhookDelivery(deliveryRecord("msg_b", "wh_b"));

    await expect(
      store.listWebhookDeliveries("wh_a", 20, "msg_b"),
    ).rejects.toMatchObject({
      name: "validation_error",
      message: "The pagination cursor is invalid.",
    });
  });
});
