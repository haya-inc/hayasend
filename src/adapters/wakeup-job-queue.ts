import { safeErrorCategory } from "../core/error-telemetry.js";
import type { Job } from "../core/types.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { JobWakeupPublisher } from "../ports/job-wakeup.js";

export interface WakeupJobQueueOptions {
  log?:
    | ((entry: Record<string, string | number | boolean>) => void)
    | undefined;
}

export class WakeupJobQueue implements JobQueue {
  private readonly log: (
    entry: Record<string, string | number | boolean>,
  ) => void;

  constructor(
    private readonly durableQueue: JobQueue,
    private readonly wakeup: JobWakeupPublisher,
    options: WakeupJobQueueOptions = {},
  ) {
    this.log =
      options.log ??
      ((entry) => {
        console.info(JSON.stringify(entry));
      });
  }

  async enqueue(job: Job, delaySeconds = 0): Promise<void> {
    await this.durableQueue.enqueue(job, delaySeconds);
    if (delaySeconds !== 0) {
      return;
    }
    try {
      await this.wakeup.publish();
    } catch (error) {
      this.log({
        level: "warn",
        message:
          "Portable queue wake-up failed after durable PostgreSQL enqueue",
        error_type: safeErrorCategory(error),
      });
    }
  }
}
