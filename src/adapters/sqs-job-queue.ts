import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Job } from "../core/types.js";
import type { JobQueue } from "../ports/job-queue.js";

export class SqsJobQueue implements JobQueue {
  constructor(
    private readonly queueUrl: string,
    private readonly client = new SQSClient({}),
  ) {}

  async enqueue(job: Job, delaySeconds = 0): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(job),
        DelaySeconds: Math.max(0, Math.min(900, delaySeconds)),
      }),
    );
  }
}

export class LocalJobQueue implements JobQueue {
  private handler?: (job: Job) => Promise<void>;

  setHandler(handler: (job: Job) => Promise<void>) {
    this.handler = handler;
  }

  async enqueue(job: Job, delaySeconds = 0): Promise<void> {
    const run = async () => {
      if (!this.handler) {
        return;
      }
      try {
        await this.handler(job);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "Local job failed",
            job_type: job.type,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    };

    if (delaySeconds > 0) {
      setTimeout(run, delaySeconds * 1_000).unref();
    } else {
      queueMicrotask(run);
    }
  }
}

export class CapturingJobQueue implements JobQueue {
  readonly jobs: Array<{ job: Job; delaySeconds: number }> = [];

  async enqueue(job: Job, delaySeconds = 0): Promise<void> {
    this.jobs.push({ job: structuredClone(job), delaySeconds });
  }
}
