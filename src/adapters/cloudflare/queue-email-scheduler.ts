import { delaySecondsUntil } from "../../core/schedule.js";
import type { EmailScheduler } from "../../ports/email-scheduler.js";
import type { JobQueue } from "../../ports/job-queue.js";

export class CloudflareQueueEmailScheduler implements EmailScheduler {
  constructor(private readonly queue: JobQueue) {}

  async schedule(
    _emailId: string,
    scheduledAt?: string,
    now = new Date(),
    jobId?: string,
  ): Promise<void> {
    await this.queue.enqueue(
      {
        type: "reconcile_outbox",
        ...(jobId ? { outbox_id: jobId } : {}),
      },
      delaySecondsUntil(scheduledAt, now),
    );
  }

  async reschedule(
    emailId: string,
    scheduledAt: string,
    now = new Date(),
    jobId?: string,
  ): Promise<void> {
    await this.schedule(emailId, scheduledAt, now, jobId);
  }

  async rescheduleDelivery(
    emailId: string,
    scheduledAt: string,
    now = new Date(),
  ): Promise<void> {
    await this.queue.enqueue(
      { type: "send_email", email_id: emailId },
      delaySecondsUntil(scheduledAt, now),
    );
  }

  async cancel(_emailId: string): Promise<void> {}
}
