import { describe, expect, it } from "vitest";
import { WakeupJobQueue } from "../src/adapters/wakeup-job-queue.js";
import type { Job } from "../src/core/types.js";
import type { JobQueue } from "../src/ports/job-queue.js";

class RecordingQueue implements JobQueue {
  readonly events: string[] = [];

  async enqueue(_job: Job, delaySeconds = 0): Promise<void> {
    this.events.push(`postgres:${delaySeconds}`);
  }
}

describe("best-effort queue wake-up", () => {
  it("publishes only after PostgreSQL durably accepts immediate work", async () => {
    const durable = new RecordingQueue();
    const queue = new WakeupJobQueue(durable, {
      publish: async () => {
        durable.events.push("wakeup");
      },
    });

    await queue.enqueue({
      type: "send_email",
      email_id: "email_wakeup_00000000000000001",
    });

    expect(durable.events).toEqual(["postgres:0", "wakeup"]);
  });

  it("keeps durable acceptance successful when wake-up publishing fails", async () => {
    const durable = new RecordingQueue();
    const logs: Array<Record<string, string | number | boolean>> = [];
    const queue = new WakeupJobQueue(
      durable,
      {
        publish: async () => {
          throw new Error(
            "private recipient@example.net and provider payload",
          );
        },
      },
      {
        log: (entry) => logs.push(entry),
      },
    );

    await expect(
      queue.enqueue({
        type: "send_email",
        email_id: "email_wakeup_00000000000000002",
      }),
    ).resolves.toBeUndefined();
    expect(durable.events).toEqual(["postgres:0"]);
    expect(logs).toEqual([
      {
        level: "warn",
        message:
          "Portable queue wake-up failed after durable PostgreSQL enqueue",
        error_type: "application_error",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("recipient@example");
    expect(JSON.stringify(logs)).not.toContain("provider payload");
  });

  it("leaves delayed work entirely owned by PostgreSQL", async () => {
    const durable = new RecordingQueue();
    let wakeups = 0;
    const queue = new WakeupJobQueue(durable, {
      publish: async () => {
        wakeups += 1;
      },
    });

    await queue.enqueue(
      {
        type: "send_email",
        email_id: "email_wakeup_00000000000000003",
      },
      30 * 24 * 60 * 60,
    );

    expect(durable.events).toEqual(["postgres:2592000"]);
    expect(wakeups).toBe(0);
  });
});
