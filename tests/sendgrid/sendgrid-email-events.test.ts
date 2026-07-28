import {
  generateKeyPairSync,
  sign as signPayload,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryAttachmentStorage } from "../../src/adapters/attachment-storage.js";
import { QueueEmailScheduler } from "../../src/adapters/email-scheduler.js";
import { MemoryStore } from "../../src/adapters/memory-store.js";
import {
  SendGridEmailEventIngress,
  processSendGridEmailEvent,
  type SendGridEmailEvent,
} from "../../src/adapters/sendgrid/sendgrid-email-events.js";
import { CapturingJobQueue } from "../../src/adapters/sqs-job-queue.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../../src/ports/mail-transport.js";
import { AttachmentService } from "../../src/services/attachment-service.js";
import { EmailService } from "../../src/services/email-service.js";
import { SuppressionService } from "../../src/services/suppression-service.js";
import { WebhookService } from "../../src/services/webhook-service.js";

const PROVIDER_MESSAGE_ID =
  "<email_sendgridtransport00000000000001@example.com>";

const transport: MailTransport = {
  async send(): Promise<MailTransportResult> {
    return { provider_id: PROVIDER_MESSAGE_ID };
  },
};

function fixture() {
  const store = new MemoryStore();
  const queue = new CapturingJobQueue();
  const webhooks = new WebhookService(store, queue, {
    httpFetch: fetch,
    validateEndpoint: async () => undefined,
  });
  const suppressionService = new SuppressionService(store);
  const emailService = new EmailService(
    store,
    new QueueEmailScheduler(queue),
    transport,
    webhooks,
    suppressionService,
    new AttachmentService(store, new MemoryAttachmentStorage()),
    undefined,
    {
      provider: {
        name: "sendgrid",
        adapter_version: "0.3.0",
        capability_version: "1.0.0",
      },
    },
  );
  return {
    emailService,
    store,
    suppressionService,
    services: { emailService, suppressionService },
  };
}

async function acceptedFixture() {
  const services = fixture();
  const created = await services.emailService.create({
    from: "sender@example.com",
    to: ["recipient@example.net"],
    subject: "SendGrid lifecycle",
    text: "Body",
  });
  await services.emailService.processSend(created.record.id);
  return { ...services, messageId: created.record.id };
}

function event(
  messageId: string,
  type: SendGridEmailEvent["event"],
  id = `sendgrid-${type}`,
  timestamp = 1_785_283_500,
): SendGridEmailEvent {
  return {
    email: "recipient@example.net",
    timestamp,
    event: type,
    sg_event_id: id,
    sg_message_id: "sendgrid-internal-message-id",
    hayasend_message_id: messageId,
    hayasend_provider_id: PROVIDER_MESSAGE_ID,
  };
}

describe("SendGrid signed Event Webhook", () => {
  it.each([
    ["processed", "sent", "accepted", undefined],
    ["deferred", "delivery_delayed", "delayed", "provider_unavailable"],
    ["delivered", "delivered", "delivered", undefined],
    ["bounce", "bounced", "bounced", "provider_rejected"],
    ["dropped", "failed", "rejected", "provider_rejected"],
    ["spamreport", "complained", "complained", undefined],
    ["open", "opened", "opened", undefined],
    ["click", "clicked", "clicked", undefined],
  ] as const)(
    "normalizes %s into the exact recipient ledger",
    async (providerEvent, publicStatus, providerType, diagnostic) => {
      const services = await acceptedFixture();
      await processSendGridEmailEvent(
        event(services.messageId, providerEvent),
        services.services,
        "2026-07-29T00:05:01.000Z",
      );

      const ledger = await services.store.getDeliveryLedger(
        services.messageId,
      );
      expect(ledger?.email.status).toBe(publicStatus);
      expect(ledger?.events).toEqual([
        expect.objectContaining({
          source: {
            kind: "provider_event_id",
            value: `sendgrid-${providerEvent}`,
          },
          provider_message_id: PROVIDER_MESSAGE_ID,
          recipient_ids: [ledger?.recipients[0]?.id],
          type: providerType,
          ...(diagnostic
            ? { diagnostic_category: diagnostic }
            : {}),
        }),
      ]);
      if (providerEvent === "bounce" || providerEvent === "spamreport") {
        await expect(
          services.suppressionService.get("recipient@example.net"),
        ).resolves.toMatchObject({
          reason:
            providerEvent === "bounce" ? "bounce" : "complaint",
          source_email_id: services.messageId,
        });
      }
    },
  );

  it("deduplicates replay and never regresses terminal recipient state", async () => {
    const services = await acceptedFixture();
    const delivered = event(
      services.messageId,
      "delivered",
      "sendgrid-delivered-order",
      1_785_283_500,
    );
    const deferred = event(
      services.messageId,
      "deferred",
      "sendgrid-deferred-order",
      1_785_283_100,
    );

    await processSendGridEmailEvent(delivered, services.services);
    await processSendGridEmailEvent(delivered, services.services);
    await processSendGridEmailEvent(deferred, services.services);

    const ledger = await services.store.getDeliveryLedger(
      services.messageId,
    );
    expect(ledger?.events).toHaveLength(2);
    expect(ledger?.recipients[0]?.status).toBe("delivered");
    expect(ledger?.email.status).toBe("delivered");
  });

  it("rejects unknown recipients before creating suppressions", async () => {
    const services = await acceptedFixture();
    const malicious = {
      ...event(services.messageId, "bounce"),
      email: "unrelated@example.net",
    };
    await expect(
      processSendGridEmailEvent(malicious, services.services),
    ).rejects.toThrow("unknown recipient");
    await expect(
      services.suppressionService.get("unrelated@example.net"),
    ).rejects.toThrow("not found");
  });

  it("verifies the exact raw bytes before parsing a complete batch", async () => {
    const services = await acceptedFixture();
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicKeyPem = publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const ingress = new SendGridEmailEventIngress(
      services.services,
      publicKeyPem,
    );
    const timestamp = "1785283500";
    const rawBody = new TextEncoder().encode(
      JSON.stringify([
        event(
          services.messageId,
          "delivered",
          "sendgrid-signed-delivered",
        ),
      ]),
    );
    const signature = signPayload(
      "sha256",
      Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]),
      privateKey,
    ).toString("base64");

    await expect(
      ingress.receive(rawBody, {
        signature,
        timestamp,
        received_at: "2026-07-29T00:05:01.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(
      (
        await services.store.getDeliveryLedger(services.messageId)
      )?.email.status,
    ).toBe("delivered");

    const transformed = new TextEncoder().encode(
      `${new TextDecoder().decode(rawBody)} `,
    );
    await expect(
      ingress.receive(transformed, { signature, timestamp }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("fails closed before parsing on missing signatures and validates only signed JSON", async () => {
    const services = await acceptedFixture();
    const verifier = { verify: vi.fn(() => false) };
    const ingress = new SendGridEmailEventIngress(
      services.services,
      "unused-under-test",
      verifier,
    );
    const rawBody = new TextEncoder().encode("{not-json");

    await expect(
      ingress.receive(rawBody, {
        signature: "forged",
        timestamp: "1785283500",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(verifier.verify).toHaveBeenCalledWith(
      rawBody,
      "forged",
      "1785283500",
    );
  });
});
