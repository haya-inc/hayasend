import type { SNSEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import {
  handleSesEvent,
  processSesEvent,
} from "../src/aws/ses-events.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { MemoryAttachmentStorage } from "../src/adapters/attachment-storage.js";
import { QueueEmailScheduler } from "../src/adapters/email-scheduler.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../src/ports/mail-transport.js";
import { EmailService } from "../src/services/email-service.js";
import { AttachmentService } from "../src/services/attachment-service.js";
import { SuppressionService } from "../src/services/suppression-service.js";
import { WebhookService } from "../src/services/webhook-service.js";

const transport: MailTransport = {
  async send(): Promise<MailTransportResult> {
    return { provider_id: "provider" };
  },
};

function fixture() {
  const store = new MemoryStore();
  const queue = new CapturingJobQueue();
  const webhooks = new WebhookService(store, queue, {
    validateEndpoint: async () => undefined,
  });
  const suppressionService = new SuppressionService(store);
  const scheduler = new QueueEmailScheduler(queue);
  const attachmentService = new AttachmentService(
    store,
    new MemoryAttachmentStorage(),
  );
  const emailService = new EmailService(
    store,
    scheduler,
    transport,
    webhooks,
    suppressionService,
    attachmentService,
  );
  return {
    emailService,
    suppressionService,
    store,
    queue,
    webhooks,
  };
}

describe("SES event processing", () => {
  it("publishes an older normalized event without regressing recipient state", async () => {
    const services = fixture();
    await services.webhooks.create({
      endpoint: "https://example.com/provider-events",
      events: ["email.delivered", "email.delivery_delayed"],
    });
    const created = await services.emailService.create({
      from: "sender@example.com",
      to: ["recipient@example.net"],
      subject: "Ordering",
      text: "Body",
    });
    await services.emailService.processSend(created.record.id);
    const baseMail = {
      messageId: "provider",
      destination: ["recipient@example.net"],
      tags: { hayasend_id: [created.record.id] },
    };

    await processSesEvent(
      {
        eventType: "Delivery",
        mail: {
          ...baseMail,
          timestamp: "2026-07-26T03:00:00.000Z",
        },
        delivery: {
          timestamp: "2026-07-26T03:05:00.000Z",
          recipients: ["recipient@example.net"],
        },
      },
      services,
      {
        providerEventId: "sns-delivered",
        receivedAt: "2026-07-26T03:05:01.000Z",
      },
    );
    await processSesEvent(
      {
        eventType: "DeliveryDelay",
        mail: {
          ...baseMail,
          timestamp: "2026-07-26T03:00:00.000Z",
        },
        deliveryDelay: {
          timestamp: "2026-07-26T03:01:00.000Z",
          delayedRecipients: [
            { emailAddress: "recipient@example.net" },
          ],
        },
      },
      services,
      {
        providerEventId: "sns-delayed",
        receivedAt: "2026-07-26T03:06:00.000Z",
      },
    );

    await expect(
      services.store.getDeliveryLedger(created.record.id),
    ).resolves.toMatchObject({
      recipients: [{ status: "delivered" }],
      events: [{ type: "delivered" }, { type: "delayed" }],
    });
    expect(
      services.queue.jobs.filter(
        ({ job }) => job.type === "deliver_webhook",
      ),
    ).toHaveLength(2);
  });

  it("deduplicates SNS events and mutates only exactly correlated recipients", async () => {
    const services = fixture();
    const created = await services.emailService.create({
      from: "sender@example.com",
      to: ["first@example.net", "second@example.net"],
      subject: "Sensitive subject",
      text: "Sensitive body",
    });
    await services.emailService.processSend(created.record.id);
    const sesEvent = {
      eventType: "Delivery",
      mail: {
        messageId: "provider",
        timestamp: "2026-07-26T03:00:00.000Z",
        destination: ["first@example.net", "second@example.net"],
        tags: { hayasend_id: [created.record.id] },
      },
      delivery: {
        timestamp: "2026-07-26T03:01:00.000Z",
        recipients: ["first@example.net"],
        smtpResponse: "smtp private response must not be retained",
      },
    };
    const context = {
      providerEventId: "sns-message-id-1",
      receivedAt: "2026-07-26T03:01:01.000Z",
    };

    await processSesEvent(sesEvent, services, context);
    await processSesEvent(sesEvent, services, context);

    const ledger = await services.store.getDeliveryLedger(created.record.id);
    expect(
      ledger?.recipients.map((recipient) => recipient.status),
    ).toEqual(["delivered", "accepted"]);
    expect(ledger?.events).toHaveLength(1);
    expect(ledger?.events[0]).toMatchObject({
      source: {
        kind: "provider_event_id",
        value: "sns-message-id-1",
      },
      provider_message_id: "provider",
      type: "delivered",
      recipient_ids: [ledger?.recipients[0]?.id],
    });
    const serialized = JSON.stringify(ledger?.events);
    expect(serialized).not.toContain("first@example.net");
    expect(serialized).not.toContain("Sensitive subject");
    expect(serialized).not.toContain("Sensitive body");
    expect(serialized).not.toContain("smtp private");
  });

  it("records multi-recipient engagement without guessing a recipient", async () => {
    const services = fixture();
    const created = await services.emailService.create({
      from: "sender@example.com",
      to: ["first@example.net", "second@example.net"],
      subject: "Engagement",
      text: "Body",
    });
    await services.emailService.processSend(created.record.id);

    await processSesEvent(
      {
        eventType: "Open",
        mail: {
          messageId: "provider",
          timestamp: "2026-07-26T03:00:00.000Z",
          destination: ["first@example.net", "second@example.net"],
          tags: { hayasend_id: [created.record.id] },
        },
        open: { timestamp: "2026-07-26T03:02:00.000Z" },
      },
      services,
      {
        providerEventId: "sns-message-id-open",
        receivedAt: "2026-07-26T03:02:01.000Z",
      },
    );

    const ledger = await services.store.getDeliveryLedger(created.record.id);
    expect(
      ledger?.recipients.map((recipient) => recipient.status),
    ).toEqual(["accepted", "accepted"]);
    expect(ledger?.events).toMatchObject([
      { type: "opened", recipient_ids: [] },
    ]);
  });

  it("adds permanent bounces to the suppression list", async () => {
    const services = fixture();
    const created = await services.emailService.create({
      from: "sender@example.com",
      to: ["hard-bounce@example.net"],
      subject: "Bounce test",
      text: "Body",
    });
    await services.emailService.processSend(created.record.id);
    await processSesEvent(
      {
        eventType: "Bounce",
        mail: {
          messageId: "provider",
          timestamp: "2026-07-26T03:00:00.000Z",
          destination: ["hard-bounce@example.net"],
          tags: { hayasend_id: [created.record.id] },
        },
        bounce: {
          timestamp: "2026-07-26T03:01:00.000Z",
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [
            {
              emailAddress: "hard-bounce@example.net",
              diagnosticCode: "smtp; 550 mailbox unavailable",
            },
          ],
        },
      },
      services,
      {
        providerEventId: "sns-hard-bounce",
        receivedAt: "2026-07-26T03:01:01.000Z",
      },
    );

    await expect(
      services.suppressionService.get("hard-bounce@example.net"),
    ).resolves.toMatchObject({
      reason: "bounce",
      source_email_id: created.record.id,
    });
  });

  it("does not suppress transient bounces", async () => {
    const services = fixture();
    const created = await services.emailService.create({
      from: "sender@example.com",
      to: ["temporary@example.net"],
      subject: "Bounce test",
      text: "Body",
    });
    await services.emailService.processSend(created.record.id);
    await processSesEvent(
      {
        eventType: "Bounce",
        mail: {
          messageId: "provider",
          timestamp: "2026-07-26T03:00:00.000Z",
          destination: ["temporary@example.net"],
          tags: { hayasend_id: [created.record.id] },
        },
        bounce: {
          timestamp: "2026-07-26T03:01:00.000Z",
          bounceType: "Transient",
          bouncedRecipients: [{ emailAddress: "temporary@example.net" }],
        },
      },
      services,
      {
        providerEventId: "sns-transient-bounce",
        receivedAt: "2026-07-26T03:01:01.000Z",
      },
    );
    await expect(
      services.suppressionService.get("temporary@example.net"),
    ).rejects.toThrow("Suppression was not found");
  });

  it("retries with a sanitized error and logs no provider event details", async () => {
    const sensitive =
      "recipient@example.net smtp private detail re_secret_token";
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const metrics = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const event = {
      Records: [
        {
          Sns: {
            Message: JSON.stringify({
              eventType: "Delivery",
              mail: { tags: { hayasend_id: ["email_123"] } },
              delivery: { smtpResponse: sensitive },
            }),
          },
        },
      ],
    } as SNSEvent;
    try {
      await expect(
        handleSesEvent(event, {
          emailService: {
            applyProviderEvent: vi.fn(async () => {
              throw new Error(sensitive);
            }),
          },
          suppressionService: {
            put: vi.fn(async (input) => ({
              id: "suppression_123",
              email: input.email,
              reason: input.reason,
              created_at: "2026-07-26T00:00:00.000Z",
              updated_at: "2026-07-26T00:00:00.000Z",
              ...(input.source_email_id
                ? { source_email_id: input.source_email_id }
                : {}),
              ...(input.detail ? { detail: input.detail } : {}),
            })),
          },
        }),
      ).rejects.toMatchObject({
        name: "HayaSendOperationalError",
        message: "SES event processing failed (application_error).",
      });

      const logged = errors.mock.calls.flat().join(" ");
      expect(logged).toContain('"error_type":"application_error"');
      expect(logged).not.toContain(sensitive);
      expect(metrics.mock.calls.flat().join(" ")).not.toContain(sensitive);
    } finally {
      errors.mockRestore();
      metrics.mockRestore();
    }
  });
});
