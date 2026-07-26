import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { MemoryAttachmentStorage } from "../src/adapters/attachment-storage.js";
import { QueueEmailScheduler } from "../src/adapters/email-scheduler.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import type { EmailRecord } from "../src/core/types.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../src/ports/mail-transport.js";
import type { EmailScheduler } from "../src/ports/email-scheduler.js";
import { EmailService } from "../src/services/email-service.js";
import { AttachmentService } from "../src/services/attachment-service.js";
import { SuppressionService } from "../src/services/suppression-service.js";
import { WebhookService } from "../src/services/webhook-service.js";
import { TemplateService } from "../src/services/template-service.js";

class StubTransport implements MailTransport {
  readonly sent: EmailRecord[] = [];
  failures = 0;

  async send(email: EmailRecord): Promise<MailTransportResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("temporary provider failure");
    }
    this.sent.push(structuredClone(email));
    return { provider_id: "ses-message-id" };
  }
}

class RecordingEmailScheduler implements EmailScheduler {
  readonly canceled: string[] = [];
  readonly rescheduled: Array<{
    emailId: string;
    scheduledAt: string;
  }> = [];
  onFirstReschedule?: () => Promise<void>;

  constructor(private readonly queueScheduler: QueueEmailScheduler) {}

  async schedule(
    emailId: string,
    scheduledAt?: string,
    now?: Date,
  ): Promise<void> {
    await this.queueScheduler.schedule(emailId, scheduledAt, now);
  }

  async reschedule(
    emailId: string,
    scheduledAt: string,
    now?: Date,
  ): Promise<void> {
    this.rescheduled.push({ emailId, scheduledAt });
    if (this.rescheduled.length === 1 && this.onFirstReschedule) {
      await this.onFirstReschedule();
    }
    await this.queueScheduler.reschedule(emailId, scheduledAt, now);
  }

  async cancel(emailId: string): Promise<void> {
    this.canceled.push(emailId);
  }
}

function fixture() {
  const store = new MemoryStore();
  const queue = new CapturingJobQueue();
  const transport = new StubTransport();
  const webhooks = new WebhookService(store, queue, {
    validateEndpoint: async () => undefined,
  });
  const suppressions = new SuppressionService(store);
  const attachments = new AttachmentService(
    store,
    new MemoryAttachmentStorage(),
  );
  const scheduler = new RecordingEmailScheduler(new QueueEmailScheduler(queue));
  const templates = new TemplateService(store);
  const service = new EmailService(
    store,
    scheduler,
    transport,
    webhooks,
    suppressions,
    attachments,
    templates,
  );
  return {
    queue,
    scheduler,
    service,
    store,
    suppressions,
    templates,
    transport,
    webhooks,
  };
}

const input = {
  from: "sender@example.com",
  to: ["recipient@example.net"],
  subject: "A subject",
  text: "A body",
};

describe("EmailService", () => {
  it("preflights a strict batch before creating or queueing any email", async () => {
    const { queue, service, store } = fixture();

    await expect(
      service.createBatch([
        input,
        {
          to: ["template-recipient@example.net"],
          template: { id: "missing-template" },
        },
      ]),
    ).rejects.toThrow("Template");

    await expect(store.listEmails(100)).resolves.toMatchObject({ data: [] });
    expect(queue.jobs).toHaveLength(0);
  });

  it("keeps a template send idempotent across later publications", async () => {
    const { queue, service, templates } = fixture();
    const template = await templates.create({
      name: "Idempotent template",
      from: "sender@example.com",
      subject: "Version one",
      html: "<p>One</p>",
    });
    await templates.publish(template.id);
    const request = {
      to: ["recipient@example.net"],
      template: { id: template.id },
    };
    const first = await service.create(request, "template-request");

    await templates.update(template.id, {
      subject: "Version two",
      html: "<p>Two</p>",
    });
    await templates.publish(template.id);
    const replay = await service.create(request, "template-request");

    expect(replay).toMatchObject({
      replayed: true,
      record: {
        id: first.record.id,
        subject: "Version one",
        html: "<p>One</p>",
      },
    });
    expect(queue.jobs).toHaveLength(1);
  });

  it("sends a queued email once and records the provider id", async () => {
    const { service, store, transport } = fixture();
    const created = await service.create(input);
    await service.processSend(created.record.id);
    expect(transport.sent).toHaveLength(1);
    await expect(store.getEmail(created.record.id)).resolves.toMatchObject({
      status: "sent",
      provider_id: "ses-message-id",
      attempts: 1,
    });

    await service.processSend(created.record.id);
    expect(transport.sent).toHaveLength(1);
  });

  it("claims a queued message before sending to stop concurrent duplicates", async () => {
    const { service, transport } = fixture();
    const created = await service.create(input);
    await Promise.all([
      service.processSend(created.record.id),
      service.processSend(created.record.id),
    ]);
    expect(transport.sent).toHaveLength(1);
  });

  it("marks a provider failure final on the third queue delivery", async () => {
    const { service, store, transport } = fixture();
    transport.failures = 3;
    const created = await service.create(input);
    await expect(service.processSend(created.record.id, 1)).rejects.toThrow(
      "temporary provider failure",
    );
    await expect(service.processSend(created.record.id, 2)).rejects.toThrow(
      "temporary provider failure",
    );
    await expect(service.processSend(created.record.id, 3)).resolves.toBe(
      undefined,
    );
    await expect(store.getEmail(created.record.id)).resolves.toMatchObject({
      status: "failed",
      error: "Email delivery failed (application_error).",
    });
  });

  it("does not persist or publish sensitive provider error text", async () => {
    const { queue, service, store, transport, webhooks } = fixture();
    const sensitive =
      "recipient@example.net private body re_secret_token https://example.com/hook";
    transport.failures = 3;
    vi.spyOn(transport, "send").mockRejectedValue(new Error(sensitive));
    await webhooks.create({
      endpoint: "https://example.com/hook",
      events: ["email.failed"],
    });
    const created = await service.create(input);

    await expect(service.processSend(created.record.id, 3)).resolves.toBe(
      undefined,
    );

    const stored = await store.getEmail(created.record.id);
    expect(stored?.error).toBe("Email delivery failed (application_error).");
    const serializedJobs = JSON.stringify(queue.jobs);
    expect(serializedJobs).toContain(
      "Email delivery failed (application_error).",
    );
    expect(serializedJobs).not.toContain(sensitive);
  });

  it("understands Resend-style relative scheduling", async () => {
    const { queue, service } = fixture();
    const now = new Date("2026-07-26T00:00:00.000Z");
    const created = await service.create(
      { ...input, scheduled_at: "in 10 minutes" },
      undefined,
      now,
    );
    expect(created.record).toMatchObject({
      status: "scheduled",
      scheduled_at: "2026-07-26T00:10:00.000Z",
    });
    expect(queue.jobs[0]?.delaySeconds).toBe(600);
  });

  it("applies the 30-day scheduling limit to relative values", async () => {
    const { service } = fixture();
    const now = new Date("2026-07-26T00:00:00.000Z");
    await expect(
      service.create({ ...input, scheduled_at: "in 31 days" }, undefined, now),
    ).rejects.toThrow("no more than 30 days");
    await expect(
      service.create({ ...input, scheduled_at: "in 0 days" }, undefined, now),
    ).rejects.toThrow("must be in the future");
  });

  it("cancels the external schedule when an email is canceled", async () => {
    const { scheduler, service } = fixture();
    const created = await service.create(input);

    await service.cancel(created.record.id);

    expect(scheduler.canceled).toEqual([created.record.id]);
  });

  it("replaces a schedule and repairs stale early delivery jobs", async () => {
    const { scheduler, service, transport } = fixture();
    const created = await service.create(input);
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();

    await service.reschedule(created.record.id, scheduledAt);
    await service.processSend(created.record.id);

    expect(scheduler.rescheduled).toEqual([
      { emailId: created.record.id, scheduledAt },
      { emailId: created.record.id, scheduledAt },
    ]);
    expect(transport.sent).toHaveLength(0);
  });

  it("reconciles a concurrent reschedule to the stored source of truth", async () => {
    const { scheduler, service, store } = fixture();
    const created = await service.create(input);
    const firstTime = new Date(Date.now() + 86_400_000).toISOString();
    const winningTime = new Date(Date.now() + 2 * 86_400_000).toISOString();
    scheduler.onFirstReschedule = async () => {
      await store.updateEmail(created.record.id, {
        scheduled_at: winningTime,
        status: "scheduled",
        updated_at: new Date().toISOString(),
      });
    };

    await service.reschedule(created.record.id, firstTime);

    expect(scheduler.rescheduled).toEqual([
      { emailId: created.record.id, scheduledAt: firstTime },
      { emailId: created.record.id, scheduledAt: winningTime },
    ]);
  });

  it("does not enqueue or deliver to a suppressed recipient", async () => {
    const { queue, service, suppressions, transport } = fixture();
    await suppressions.put({
      email: "Recipient <recipient@example.net>",
      reason: "complaint",
    });
    const created = await service.create(input);
    expect(created.record.status).toBe("suppressed");
    expect(queue.jobs).toHaveLength(0);
    await service.processSend(created.record.id);
    expect(transport.sent).toHaveLength(0);
  });

  it("rechecks suppressions immediately before delivery", async () => {
    const { service, store, suppressions, transport } = fixture();
    const created = await service.create(input);
    await suppressions.put({
      email: "recipient@example.net",
      reason: "bounce",
    });

    await service.processSend(created.record.id);

    expect(transport.sent).toHaveLength(0);
    await expect(store.getEmail(created.record.id)).resolves.toMatchObject({
      status: "suppressed",
      last_event: "suppressed",
    });
  });
});
