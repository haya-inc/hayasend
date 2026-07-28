import { utf8ByteLength } from "./bytes.js";
import { requestHash } from "./crypto.js";
import type { Job } from "./types.js";

export const MAX_JOB_ENVELOPE_BYTES = 128_000;
export const MAX_JOB_ID_BYTES = 2_048;

export interface JobEnvelope {
  schema_version: "1.0.0";
  id: string;
  created_at: string;
  job: Job;
}

export function jobIdentity(job: Job): string {
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

export function isJob(value: unknown): value is Job {
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
    return job.outbox_id === undefined || typeof job.outbox_id === "string";
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

export function createJobEnvelope(
  job: Job,
  now = new Date(),
): JobEnvelope {
  const envelope: JobEnvelope = {
    schema_version: "1.0.0",
    id: jobIdentity(job),
    created_at: now.toISOString(),
    job: structuredClone(job),
  };
  if (utf8ByteLength(envelope.id) > MAX_JOB_ID_BYTES) {
    throw new Error(`Queue job IDs must not exceed ${MAX_JOB_ID_BYTES} bytes.`);
  }
  if (utf8ByteLength(JSON.stringify(envelope)) > MAX_JOB_ENVELOPE_BYTES) {
    throw new Error(
      `Queue messages must not exceed ${MAX_JOB_ENVELOPE_BYTES} bytes.`,
    );
  }
  return envelope;
}

export function parseJobEnvelope(value: unknown): JobEnvelope {
  if (value === null || typeof value !== "object") {
    throw new Error("Queue payload is not an object.");
  }
  const envelope = value as Partial<JobEnvelope>;
  if (
    envelope.schema_version !== "1.0.0" ||
    typeof envelope.id !== "string" ||
    utf8ByteLength(envelope.id) > MAX_JOB_ID_BYTES ||
    typeof envelope.created_at !== "string" ||
    !Number.isFinite(Date.parse(envelope.created_at)) ||
    !isJob(envelope.job) ||
    envelope.id !== jobIdentity(envelope.job)
  ) {
    throw new Error("Queue payload is not a valid deterministic job.");
  }
  if (utf8ByteLength(JSON.stringify(envelope)) > MAX_JOB_ENVELOPE_BYTES) {
    throw new Error(
      `Queue messages must not exceed ${MAX_JOB_ENVELOPE_BYTES} bytes.`,
    );
  }
  return structuredClone(envelope as JobEnvelope);
}
