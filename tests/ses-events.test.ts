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
  const webhooks = new WebhookService(store, queue);
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
  return { emailService, suppressionService };
}

describe("SES event processing", () => {
  it("adds permanent bounces to the suppression list", async () => {
    const services = fixture();
    const created = await services.emailService.create({
      from: "sender@example.com",
      to: ["hard-bounce@example.net"],
      subject: "Bounce test",
      text: "Body",
    });
    await processSesEvent(
      {
        eventType: "Bounce",
        mail: { tags: { hayasend_id: [created.record.id] } },
        bounce: {
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
    await processSesEvent(
      {
        eventType: "Bounce",
        mail: { tags: { hayasend_id: [created.record.id] } },
        bounce: {
          bounceType: "Transient",
          bouncedRecipients: [{ emailAddress: "temporary@example.net" }],
        },
      },
      services,
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
