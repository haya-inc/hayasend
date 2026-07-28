import { safeErrorCategory } from "../../core/error-telemetry.js";
import {
  createJobEnvelope,
  parseJobEnvelope,
  type JobEnvelope,
} from "../../core/job-envelope.js";
import type { Job } from "../../core/types.js";
import type { JobQueue } from "../../ports/job-queue.js";
import {
  injectCloudflareFault,
  type CloudflareFaultInjector,
} from "./fault-injection.js";

const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

export type CloudflareJobEnvelope = JobEnvelope;

export interface CloudflareQueueOptions {
  now?: (() => Date) | undefined;
  fault_injector?: CloudflareFaultInjector | undefined;
}

export interface CloudflareQueueConsumerOptions
  extends CloudflareQueueOptions {
  retry_delay_seconds?: number | undefined;
  on_diagnostic?:
    | ((diagnostic: {
        job_id?: string | undefined;
        category: string;
        source: "primary" | "dead-letter";
      }) => void | Promise<void>)
    | undefined;
}

function validateDelay(delaySeconds: number): void {
  if (
    !Number.isSafeInteger(delaySeconds) ||
    delaySeconds < 0 ||
    delaySeconds > MAX_QUEUE_DELAY_SECONDS
  ) {
    throw new Error(
      `Cloudflare queue delay must be between 0 and ${MAX_QUEUE_DELAY_SECONDS} seconds.`,
    );
  }
}

export function createCloudflareJobEnvelope(
  job: Job,
  now = new Date(),
): CloudflareJobEnvelope {
  try {
    return createJobEnvelope(job, now);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Queue messages must not exceed")
    ) {
      throw new Error(`Cloudflare ${error.message.toLowerCase()}`);
    }
    throw error;
  }
}

export class CloudflareJobQueue implements JobQueue {
  constructor(
    private readonly queue: Queue<CloudflareJobEnvelope>,
    private readonly options: CloudflareQueueOptions = {},
  ) {}

  async enqueue(job: Job, delaySeconds = 0): Promise<void> {
    validateDelay(delaySeconds);
    const envelope = createCloudflareJobEnvelope(
      job,
      this.options.now?.() ?? new Date(),
    );
    await injectCloudflareFault(this.options.fault_injector, {
      component: "queue",
      operation: "send",
      target: envelope.id,
    });
    await this.queue.send(envelope, {
      contentType: "json",
      ...(delaySeconds > 0 ? { delaySeconds } : {}),
    });
  }
}

export async function consumeCloudflareQueueBatch(
  batch: MessageBatch<CloudflareJobEnvelope>,
  handler: (
    job: Job,
    envelope: CloudflareJobEnvelope,
    attempt: number,
  ) => Promise<void>,
  options: CloudflareQueueConsumerOptions = {},
): Promise<void> {
  const retryDelay = options.retry_delay_seconds ?? 30;
  validateDelay(retryDelay);
  for (const message of batch.messages) {
    let envelope: CloudflareJobEnvelope;
    try {
      envelope = parseJobEnvelope(message.body);
    } catch {
      await options.on_diagnostic?.({
        category: "invalid_data",
        source: "primary",
      });
      message.ack();
      continue;
    }
    try {
      await injectCloudflareFault(options.fault_injector, {
        component: "queue",
        operation: "consume",
        target: envelope.id,
      });
      await handler(
        structuredClone(envelope.job),
        envelope,
        message.attempts,
      );
      message.ack();
    } catch (error) {
      await options.on_diagnostic?.({
        job_id: envelope.id,
        category: safeErrorCategory(error),
        source: "primary",
      });
      message.retry({ delaySeconds: retryDelay });
    }
  }
}

export async function recoverCloudflareDeadLetterBatch(
  batch: MessageBatch<CloudflareJobEnvelope>,
  primaryQueue: Queue<CloudflareJobEnvelope>,
  options: CloudflareQueueConsumerOptions = {},
): Promise<void> {
  for (const message of batch.messages) {
    let envelope: CloudflareJobEnvelope;
    try {
      envelope = parseJobEnvelope(message.body);
    } catch {
      await options.on_diagnostic?.({
        category: "invalid_data",
        source: "dead-letter",
      });
      message.ack();
      continue;
    }
    try {
      await injectCloudflareFault(options.fault_injector, {
        component: "queue",
        operation: "recover-send",
        target: envelope.id,
      });
      await primaryQueue.send(envelope, { contentType: "json" });
      message.ack();
    } catch (error) {
      await options.on_diagnostic?.({
        job_id: envelope.id,
        category: safeErrorCategory(error),
        source: "dead-letter",
      });
      message.retry();
    }
  }
}
