import { utf8ByteLength } from "../../core/bytes.js";
import { requestHash } from "../../core/crypto.js";
import { safeErrorCategory } from "../../core/error-telemetry.js";
import type { Job } from "../../core/types.js";
import type { JobQueue } from "../../ports/job-queue.js";
import {
  injectCloudflareFault,
  type CloudflareFaultInjector,
} from "./fault-injection.js";

const MAX_QUEUE_MESSAGE_BYTES = 128_000;
const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

export interface CloudflareJobEnvelope {
  schema_version: "1.0.0";
  id: string;
  created_at: string;
  job: Job;
}

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

function jobIdentity(job: Job): string {
  const supplied =
    job.type === "send_email"
      ? job.job_id
      : job.type === "reconcile_outbox"
        ? job.outbox_id
        : job.type === "deliver_webhook"
          ? job.delivery_id
          : undefined;
  const suffix = supplied ?? requestHash(job);
  return `job:v1:${job.type.replaceAll("_", "-")}:${suffix}`;
}

function isJob(value: unknown): value is Job {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const job = value as Partial<Job>;
  if (job.type === "send_email") {
    return (
      typeof job.email_id === "string" &&
      (job.job_id === undefined || typeof job.job_id === "string")
    );
  }
  if (job.type === "reconcile_outbox") {
    return (
      job.outbox_id === undefined || typeof job.outbox_id === "string"
    );
  }
  if (job.type === "publish_received_email") {
    return typeof job.email_id === "string";
  }
  if (job.type === "deliver_webhook") {
    return (
      typeof job.webhook_id === "string" &&
      (job.delivery_id === undefined ||
        typeof job.delivery_id === "string") &&
      job.event !== null &&
      typeof job.event === "object"
    );
  }
  return false;
}

function parseEnvelope(value: unknown): CloudflareJobEnvelope {
  if (value === null || typeof value !== "object") {
    throw new Error("Queue payload is not an object.");
  }
  const envelope = value as Partial<CloudflareJobEnvelope>;
  if (
    envelope.schema_version !== "1.0.0" ||
    typeof envelope.id !== "string" ||
    envelope.id.length > 2_048 ||
    typeof envelope.created_at !== "string" ||
    !Number.isFinite(Date.parse(envelope.created_at)) ||
    !isJob(envelope.job) ||
    envelope.id !== jobIdentity(envelope.job)
  ) {
    throw new Error("Queue payload is not a valid deterministic job.");
  }
  return structuredClone(envelope as CloudflareJobEnvelope);
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
  const envelope: CloudflareJobEnvelope = {
    schema_version: "1.0.0",
    id: jobIdentity(job),
    created_at: now.toISOString(),
    job: structuredClone(job),
  };
  if (
    utf8ByteLength(JSON.stringify(envelope)) > MAX_QUEUE_MESSAGE_BYTES
  ) {
    throw new Error(
      `Cloudflare queue messages must not exceed ${MAX_QUEUE_MESSAGE_BYTES} bytes.`,
    );
  }
  return envelope;
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
      envelope = parseEnvelope(message.body);
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
      envelope = parseEnvelope(message.body);
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
