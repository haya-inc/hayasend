import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import type { EmailRecord } from "../src/core/types.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../src/ports/mail-transport.js";
import { EmailService } from "../src/services/email-service.js";
import { WebhookService } from "../src/services/webhook-service.js";

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

function fixture() {
  const store = new MemoryStore();
  const queue = new CapturingJobQueue();
  const transport = new StubTransport();
  const webhooks = new WebhookService(store, queue);
  const service = new EmailService(store, queue, transport, webhooks);
  return { queue, service, store, transport };
}

const input = {
  from: "sender@example.com",
  to: ["recipient@example.net"],
  subject: "A subject",
  text: "A body",
};

describe("EmailService", () => {
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
      error: "temporary provider failure",
    });
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
});
