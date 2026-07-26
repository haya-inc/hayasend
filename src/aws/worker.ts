import type {
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import type { Job } from "../core/types.js";
import { safeErrorCategory } from "../core/error-telemetry.js";
import { emitCountMetric } from "../core/metrics.js";
import {
  createAwsRuntime,
  type Runtime,
} from "../runtime.js";

let runtime: Runtime | undefined;

function getRuntime() {
  runtime ??= createAwsRuntime();
  return runtime;
}

function parseJob(record: SQSRecord): Job {
  const parsed = JSON.parse(record.body) as Partial<Job>;
  if (
    parsed.type !== "send_email" &&
    parsed.type !== "publish_received_email" &&
    parsed.type !== "deliver_webhook"
  ) {
    throw new Error("Unsupported job type.");
  }
  return parsed as Job;
}

export async function processWorkerEvent(
  event: SQSEvent,
  services: Pick<Runtime, "processJob">,
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    let jobType: Job["type"] | undefined;
    try {
      const attempt = Number(record.attributes.ApproximateReceiveCount ?? 1);
      const job = parseJob(record);
      jobType = job.type;
      await services.processJob(job, attempt);
    } catch (error) {
      emitCountMetric("JobFailures");
      console.error(
        JSON.stringify({
          level: "error",
          message: "Job processing failed",
          message_id: record.messageId,
          ...(jobType ? { job_type: jobType } : {}),
          error_type: safeErrorCategory(error),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  return processWorkerEvent(event, getRuntime());
}
