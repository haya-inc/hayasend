import {
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { safeErrorCategory } from "../core/error-telemetry.js";
import type { Job } from "../core/types.js";
import type { JobQueue } from "../ports/job-queue.js";
import type {
  QueueDepth,
  QueueDiagnostics,
  QueueDiagnosticsSnapshot,
} from "../ports/queue-diagnostics.js";

interface SqsQueueDiagnosticsOptions {
  deliveryDeadLetterQueueUrl?: string | undefined;
  schedulerDeadLetterQueueUrl?: string | undefined;
  inboundDeadLetterQueueUrl?: string | undefined;
}

function queueDepth(
  attributes: Record<string, string | undefined> | undefined,
): QueueDepth {
  const count = (name: string) => {
    const value = Number(attributes?.[name] ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const visible = count("ApproximateNumberOfMessages");
  const inFlight = count("ApproximateNumberOfMessagesNotVisible");
  const delayed = count("ApproximateNumberOfMessagesDelayed");
  return {
    visible,
    in_flight: inFlight,
    delayed,
    total: visible + inFlight + delayed,
  };
}

const EMPTY_QUEUE_DEPTH: QueueDepth = {
  visible: 0,
  in_flight: 0,
  delayed: 0,
  total: 0,
};

export class SqsJobQueue implements JobQueue, QueueDiagnostics {
  constructor(
    private readonly queueUrl: string,
    private readonly client = new SQSClient({}),
    private readonly diagnostics: SqsQueueDiagnosticsOptions = {},
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

  async getQueueDiagnostics(): Promise<QueueDiagnosticsSnapshot> {
    const read = async (queueUrl: string | undefined) => {
      if (!queueUrl) {
        return null;
      }
      const result = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "ApproximateNumberOfMessagesDelayed",
          ],
        }),
      );
      return queueDepth(result.Attributes);
    };
    const [primary, delivery, scheduler, inbound] = await Promise.all([
      read(this.queueUrl),
      read(this.diagnostics.deliveryDeadLetterQueueUrl),
      read(this.diagnostics.schedulerDeadLetterQueueUrl),
      read(this.diagnostics.inboundDeadLetterQueueUrl),
    ]);
    return {
      provider: "aws-sqs",
      primary: primary ?? { ...EMPTY_QUEUE_DEPTH },
      dead_letters: { delivery, scheduler, inbound },
    };
  }
}

export class LocalJobQueue implements JobQueue, QueueDiagnostics {
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
            error_type: safeErrorCategory(error),
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

  async getQueueDiagnostics(): Promise<QueueDiagnosticsSnapshot> {
    return {
      provider: "memory",
      primary: { ...EMPTY_QUEUE_DEPTH },
      dead_letters: {
        delivery: { ...EMPTY_QUEUE_DEPTH },
        scheduler: { ...EMPTY_QUEUE_DEPTH },
        inbound: null,
      },
    };
  }
}

export class CapturingJobQueue implements JobQueue, QueueDiagnostics {
  readonly jobs: Array<{ job: Job; delaySeconds: number }> = [];

  async enqueue(job: Job, delaySeconds = 0): Promise<void> {
    this.jobs.push({ job: structuredClone(job), delaySeconds });
  }

  async getQueueDiagnostics(): Promise<QueueDiagnosticsSnapshot> {
    return {
      provider: "memory",
      primary: {
        visible: this.jobs.length,
        in_flight: 0,
        delayed: 0,
        total: this.jobs.length,
      },
      dead_letters: {
        delivery: { ...EMPTY_QUEUE_DEPTH },
        scheduler: { ...EMPTY_QUEUE_DEPTH },
        inbound: null,
      },
    };
  }
}
