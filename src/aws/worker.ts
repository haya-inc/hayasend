import type {
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import type { Job } from "../core/types.js";
import { emitCountMetric } from "../core/metrics.js";
import { createAwsRuntime } from "../runtime.js";

const runtime = createAwsRuntime();

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

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const attempt = Number(record.attributes.ApproximateReceiveCount ?? 1);
      await runtime.processJob(parseJob(record), attempt);
    } catch (error) {
      emitCountMetric("JobFailures");
      console.error(
        JSON.stringify({
          level: "error",
          message: "Job processing failed",
          message_id: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
