import type { SQSEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { processWorkerEvent } from "../src/aws/worker.js";

const SENSITIVE =
  "recipient@example.net private body re_secret_token https://example.com/hook";

function event(body: string): SQSEvent {
  return {
    Records: [
      {
        messageId: "00000000-0000-4000-8000-000000000000",
        receiptHandle: "receipt",
        body,
        attributes: {
          ApproximateReceiveCount: "2",
          SentTimestamp: "0",
          SenderId: "sender",
          ApproximateFirstReceiveTimestamp: "0",
        },
        messageAttributes: {},
        md5OfBody: "hash",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:region:account:queue",
        awsRegion: "ap-northeast-1",
      },
    ],
  };
}

describe("worker error telemetry", () => {
  it("records a safe category without the thrown message", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const metrics = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const processJob = vi.fn(async () => {
      throw new Error(SENSITIVE);
    });

    await expect(
      processWorkerEvent(
        event(JSON.stringify({ type: "send_email", email_id: "email_123" })),
        { processJob },
      ),
    ).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: "00000000-0000-4000-8000-000000000000" },
      ],
    });

    const output = errors.mock.calls.flat().join(" ");
    expect(output).toContain('"job_type":"send_email"');
    expect(output).toContain('"error_type":"application_error"');
    expect(output).not.toContain(SENSITIVE);
    expect(metrics.mock.calls.flat().join(" ")).not.toContain(SENSITIVE);
    errors.mockRestore();
    metrics.mockRestore();
  });

  it("does not echo a malformed queue body", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await processWorkerEvent(event(`not-json ${SENSITIVE}`), {
      processJob: vi.fn(async () => undefined),
    });

    const output = errors.mock.calls.flat().join(" ");
    expect(output).toContain('"error_type":"invalid_data"');
    expect(output).not.toContain(SENSITIVE);
    errors.mockRestore();
  });
});
