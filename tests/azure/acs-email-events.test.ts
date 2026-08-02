import { describe, expect, it } from "vitest";
import { MemoryAttachmentStorage } from "../../src/adapters/attachment-storage.js";
import {
  AcsEmailEventGridIngress,
  processAcsEmailDeliveryEvent,
  type AcsEmailDeliveryEvent,
} from "../../src/adapters/azure/acs-email-events.js";
import { MemoryStore } from "../../src/adapters/memory-store.js";
import { QueueEmailScheduler } from "../../src/adapters/email-scheduler.js";
import { CapturingJobQueue } from "../../src/adapters/sqs-job-queue.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../../src/ports/mail-transport.js";
import { AttachmentService } from "../../src/services/attachment-service.js";
import { EmailService } from "../../src/services/email-service.js";
import { SuppressionService } from "../../src/services/suppression-service.js";
import { WebhookService } from "../../src/services/webhook-service.js";

const PROVIDER_MESSAGE_ID = "b7ce1704-6f17-48ea-bc1c-d5a1904a5220";

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
        name: "azure-communication-services",
        adapter_version: "0.3.10",
        capability_version: "1.0.0",
      },
    },
  );
  let messageId: string | undefined;
  return {
    emailService,
    store,
    suppressionService,
    services: {
      resolver: {
        async findMessageIdByProviderMessageId(providerMessageId: string) {
          return providerMessageId === PROVIDER_MESSAGE_ID
            ? messageId
            : undefined;
        },
      },
      emailService,
      suppressionService,
    },
    setMessageId(value: string) {
      messageId = value;
    },
  };
}

function event(
  status: AcsEmailDeliveryEvent["data"]["status"],
  id = `azure-event-${status}`,
  timestamp = "2026-07-29T00:05:00.000Z",
): AcsEmailDeliveryEvent {
  return {
    id,
    topic:
      "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/proof/providers/Microsoft.Communication/communicationServices/proof",
    subject: `sender/sender/message/${PROVIDER_MESSAGE_ID}`,
    data: {
      sender: "sender@example.com",
      recipient: "recipient@example.net",
      messageId: PROVIDER_MESSAGE_ID,
      status,
      deliveryAttemptTimeStamp: timestamp,
    },
    eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
    dataVersion: "1.0",
    metadataVersion: "1",
    eventTime: timestamp,
  };
}

async function acceptedFixture() {
  const services = fixture();
  const created = await services.emailService.create({
    from: "sender@example.com",
    to: ["recipient@example.net"],
    subject: "Azure lifecycle",
    text: "Body",
  });
  services.setMessageId(created.record.id);
  await services.emailService.processSend(created.record.id);
  return { ...services, messageId: created.record.id };
}

describe("Azure Communication Services Email events", () => {
  it.each([
    ["Delivered", "delivered", "delivered", undefined],
    ["Expanded", "delivery_delayed", "delayed", undefined],
    ["Bounced", "bounced", "bounced", "provider_rejected"],
    ["Suppressed", "failed", "failed", "provider_rejected"],
    ["Quarantined", "failed", "rejected", "provider_rejected"],
    ["FilteredSpam", "failed", "rejected", "provider_rejected"],
    ["Failed", "failed", "failed", "provider_error"],
  ] as const)(
    "normalizes %s into the exact recipient ledger",
    async (status, publicStatus, providerType, diagnostic) => {
      const services = await acceptedFixture();
      await processAcsEmailDeliveryEvent(
        event(status),
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
            value: `azure-event-${status}`,
          },
          provider_message_id: PROVIDER_MESSAGE_ID,
          recipient_ids: [ledger?.recipients[0]?.id],
          type: providerType,
          ...(diagnostic
            ? { diagnostic_category: diagnostic }
            : {}),
        }),
      ]);
      if (status === "Bounced" || status === "Suppressed") {
        await expect(
          services.suppressionService.get("recipient@example.net"),
        ).resolves.toMatchObject({
          reason: "bounce",
          source_email_id: services.messageId,
        });
      }
    },
  );

  it("deduplicates Event Grid replay and does not regress after terminal delivery", async () => {
    const services = await acceptedFixture();
    const delivered = event(
      "Delivered",
      "azure-delivered-order",
      "2026-07-29T00:05:00.000Z",
    );
    const expanded = event(
      "Expanded",
      "azure-expanded-order",
      "2026-07-29T00:01:00.000Z",
    );

    await processAcsEmailDeliveryEvent(delivered, services.services);
    await processAcsEmailDeliveryEvent(delivered, services.services);
    await processAcsEmailDeliveryEvent(expanded, services.services);

    const ledger = await services.store.getDeliveryLedger(
      services.messageId,
    );
    expect(ledger?.events).toHaveLength(2);
    expect(ledger?.recipients[0]?.status).toBe("delivered");
    expect(ledger?.email.status).toBe("delivered");
  });

  it("rejects an unknown recipient without creating a suppression", async () => {
    const services = await acceptedFixture();
    const malicious = event("Bounced");
    malicious.data.recipient = "unrelated@example.net";

    await expect(
      processAcsEmailDeliveryEvent(malicious, services.services),
    ).rejects.toThrow("unknown recipient");
    await expect(
      services.suppressionService.get("unrelated@example.net"),
    ).rejects.toThrow("not found");
  });

  it("answers Event Grid validation and rejects mixed validation batches", async () => {
    const ingress = new AcsEmailEventGridIngress(fixture().services);
    const validationEvent = {
      id: "validation-event",
      topic:
        "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/proof",
      subject: "validation",
      data: { validationCode: "validation-code" },
      eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
      dataVersion: "1.0",
      metadataVersion: "1",
      eventTime: "2026-07-29T00:00:00.000Z",
    };

    await expect(ingress.receive([validationEvent])).resolves.toEqual({
      validation_response: "validation-code",
    });
    await expect(
      ingress.receive([validationEvent, validationEvent]),
    ).rejects.toThrow("must be the only event");
  });

  it("fails closed when Event Grid reports another resource topic", async () => {
    const ingress = new AcsEmailEventGridIngress(fixture().services, {
      expected_topic:
        "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/proof/providers/Microsoft.Communication/communicationServices/proof",
    });
    const delivery = event("Delivered");
    delivery.topic =
      "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/proof/providers/Microsoft.Communication/communicationServices/another";

    await expect(ingress.receive([delivery])).rejects.toThrow(
      "does not match",
    );
  });

  it("retains engagement without falsely attributing a multi-recipient event", async () => {
    const services = fixture();
    const created = await services.emailService.create({
      from: "sender@example.com",
      to: ["recipient@example.net", "second@example.net"],
      subject: "Azure engagement",
      text: "Body",
    });
    services.setMessageId(created.record.id);
    await services.emailService.processSend(created.record.id);
    const ingress = new AcsEmailEventGridIngress(services.services);

    await ingress.receive([
      {
        id: "azure-open-event",
        topic:
          "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/proof",
        subject: `sender/sender/message/${PROVIDER_MESSAGE_ID}`,
        data: {
          sender: "sender@example.com",
          messageId: PROVIDER_MESSAGE_ID,
          userActionTimeStamp: "2026-07-29T00:10:00.000Z",
          engagementType: "view",
        },
        eventType:
          "Microsoft.Communication.EmailEngagementTrackingReportReceived",
        dataVersion: "1.0",
        metadataVersion: "1",
        eventTime: "2026-07-29T00:10:00.100Z",
      },
    ]);

    const ledger = await services.store.getDeliveryLedger(created.record.id);
    expect(ledger?.events[0]).toMatchObject({
      type: "opened",
      recipient_ids: [],
    });
    expect(ledger?.recipients.map((recipient) => recipient.status)).toEqual([
      "accepted",
      "accepted",
    ]);
  });
});
