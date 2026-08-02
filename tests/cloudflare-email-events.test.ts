import { describe, expect, it } from "vitest";
import { MemoryAttachmentStorage } from "../src/adapters/attachment-storage.js";
import {
  consumeCloudflareEmailEventBatch,
  processCloudflareEmailSendingEvent,
  type CloudflareEmailSendingEvent,
} from "../src/adapters/cloudflare/email-sending-events.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { QueueEmailScheduler } from "../src/adapters/email-scheduler.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../src/ports/mail-transport.js";
import { AttachmentService } from "../src/services/attachment-service.js";
import { EmailService } from "../src/services/email-service.js";
import { SuppressionService } from "../src/services/suppression-service.js";
import { WebhookService } from "../src/services/webhook-service.js";

const PROVIDER_MESSAGE_ID = "cf-provider-message-events-1";

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
        name: "cloudflare-email",
        adapter_version: "0.3.10",
        capability_version: "1.0.0",
      },
    },
  );
  let messageId: string | undefined;
  return {
    emailService,
    queue,
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
  kind:
    | "delivered"
    | "deferred"
    | "bounced"
    | "failed"
    | "rejected"
    | "complained",
  eventId = `cf-event-${kind}`,
  timestamp = "2026-07-27T16:00:00.000Z",
): CloudflareEmailSendingEvent {
  return {
    type: `cf.email.sending.message.${kind}`,
    source: {
      type: "email.sending",
      zoneId: "zone-proof",
      domain: "example.com",
    },
    payload: {
      eventId,
      messageId: PROVIDER_MESSAGE_ID,
      recipient: "recipient@example.net",
      terminal: kind !== "deferred",
      delivery: { status: kind },
    },
    metadata: {
      accountId: "account-proof",
      eventSubscriptionId: "subscription-proof",
      eventSchemaVersion: 1,
      eventTimestamp: timestamp,
    },
  };
}

async function acceptedFixture() {
  const services = fixture();
  const created = await services.emailService.create({
    from: "sender@example.com",
    to: ["recipient@example.net"],
    subject: "Cloudflare lifecycle",
    text: "Body",
  });
  services.setMessageId(created.record.id);
  await services.emailService.processSend(created.record.id);
  return { ...services, messageId: created.record.id };
}

describe("Cloudflare Email Sending events", () => {
  it.each([
    ["delivered", "delivered", "delivered", undefined],
    [
      "deferred",
      "delivery_delayed",
      "delayed",
      "provider_unavailable",
    ],
    ["bounced", "bounced", "bounced", "provider_rejected"],
    ["failed", "failed", "failed", "provider_error"],
    ["rejected", "failed", "rejected", "provider_rejected"],
    ["complained", "complained", "complained", undefined],
  ] as const)(
    "normalizes %s into the canonical recipient ledger",
    async (kind, publicStatus, providerType, diagnostic) => {
      const services = await acceptedFixture();
      await processCloudflareEmailSendingEvent(
        event(kind),
        services.services,
        "2026-07-27T16:00:01.000Z",
      );

      const ledger = await services.store.getDeliveryLedger(
        services.messageId,
      );
      expect(ledger?.email.status).toBe(publicStatus);
      expect(ledger?.events).toEqual([
        expect.objectContaining({
          source: {
            kind: "provider_event_id",
            value: `cf-event-${kind}`,
          },
          provider_message_id: PROVIDER_MESSAGE_ID,
          recipient_ids: [ledger?.recipients[0]?.id],
          type: providerType,
          ...(diagnostic
            ? { diagnostic_category: diagnostic }
            : {}),
        }),
      ]);
      if (kind === "bounced" || kind === "complained") {
        await expect(
          services.suppressionService.get("recipient@example.net"),
        ).resolves.toMatchObject({
          reason: kind === "bounced" ? "bounce" : "complaint",
          source_email_id: services.messageId,
        });
      }
    },
  );

  it("deduplicates Queue replays and does not regress on an older deferred event", async () => {
    const services = await acceptedFixture();
    const delivered = event(
      "delivered",
      "cf-event-delivered-order",
      "2026-07-27T16:05:00.000Z",
    );
    const deferred = event(
      "deferred",
      "cf-event-deferred-order",
      "2026-07-27T16:01:00.000Z",
    );

    await processCloudflareEmailSendingEvent(
      delivered,
      services.services,
      "2026-07-27T16:05:01.000Z",
    );
    await processCloudflareEmailSendingEvent(
      delivered,
      services.services,
      "2026-07-27T16:05:02.000Z",
    );
    await processCloudflareEmailSendingEvent(
      deferred,
      services.services,
      "2026-07-27T16:06:00.000Z",
    );

    const ledger = await services.store.getDeliveryLedger(
      services.messageId,
    );
    expect(ledger?.events).toHaveLength(2);
    expect(ledger?.recipients[0]?.status).toBe("delivered");
    expect(ledger?.email.status).toBe("delivered");
  });

  it("never suppresses an uncorrelated recipient", async () => {
    const services = await acceptedFixture();
    const malicious = event("bounced");
    malicious.payload.recipient = "unrelated@example.net";

    await expect(
      processCloudflareEmailSendingEvent(
        malicious,
        services.services,
        "2026-07-27T16:00:01.000Z",
      ),
    ).rejects.toThrow("unknown recipient");
    await expect(
      services.suppressionService.get("unrelated@example.net"),
    ).rejects.toThrow("not found");
  });

  it("acks invalid poison events and retries correlation races", async () => {
    const services = fixture();
    const actions: string[] = [];
    const diagnostics: Array<{
      category: string;
      disposition: "ack" | "retry";
    }> = [];
    const batch = {
      queue: "email-events",
      messages: [
        {
          id: "invalid",
          timestamp: new Date("2026-07-27T16:00:00.000Z"),
          body: { private: "recipient@example.net private-body" },
          attempts: 1,
          ack() {
            actions.push("invalid:ack");
          },
          retry() {
            actions.push("invalid:retry");
          },
        },
        {
          id: "race",
          timestamp: new Date("2026-07-27T16:00:00.000Z"),
          body: event("delivered"),
          attempts: 1,
          ack() {
            actions.push("race:ack");
          },
          retry() {
            actions.push("race:retry");
          },
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>;

    await consumeCloudflareEmailEventBatch(batch, services.services, {
      on_diagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });

    expect(actions).toEqual(["invalid:ack", "race:retry"]);
    expect(diagnostics).toEqual([
      { category: "validation_error", disposition: "ack" },
      { category: "provider_unavailable", disposition: "retry" },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(
      "recipient@example.net",
    );
    expect(JSON.stringify(diagnostics)).not.toContain("private-body");
  });
});
