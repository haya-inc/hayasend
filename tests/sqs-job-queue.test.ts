import {
  GetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { describe, expect, it, vi } from "vitest";
import { SqsJobQueue } from "../src/adapters/sqs-job-queue.js";

describe("SqsJobQueue diagnostics", () => {
  it("[conformance:recovery-diagnostics-privacy] reports primary and dead-letter depth without exposing queue URLs", async () => {
    const depthByUrl: Record<
      string,
      Record<string, string>
    > = {
      "https://sqs.example/main": {
        ApproximateNumberOfMessages: "3",
        ApproximateNumberOfMessagesNotVisible: "2",
        ApproximateNumberOfMessagesDelayed: "1",
      },
      "https://sqs.example/delivery-dlq": {
        ApproximateNumberOfMessages: "4",
      },
      "https://sqs.example/scheduler-dlq": {
        ApproximateNumberOfMessages: "5",
      },
      "https://sqs.example/inbound-dlq": {
        ApproximateNumberOfMessages: "6",
      },
    };
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetQueueAttributesCommand);
      const queueUrl = (command as GetQueueAttributesCommand).input
        .QueueUrl;
      return { Attributes: depthByUrl[queueUrl ?? ""] };
    });
    const queue = new SqsJobQueue(
      "https://sqs.example/main",
      { send } as unknown as SQSClient,
      {
        deliveryDeadLetterQueueUrl:
          "https://sqs.example/delivery-dlq",
        schedulerDeadLetterQueueUrl:
          "https://sqs.example/scheduler-dlq",
        inboundDeadLetterQueueUrl:
          "https://sqs.example/inbound-dlq",
      },
    );

    const diagnostics = await queue.getQueueDiagnostics();

    expect(diagnostics).toEqual({
      provider: "aws-sqs",
      primary: {
        visible: 3,
        in_flight: 2,
        delayed: 1,
        total: 6,
      },
      dead_letters: {
        delivery: {
          visible: 4,
          in_flight: 0,
          delayed: 0,
          total: 4,
        },
        scheduler: {
          visible: 5,
          in_flight: 0,
          delayed: 0,
          total: 5,
        },
        inbound: {
          visible: 6,
          in_flight: 0,
          delayed: 0,
          total: 6,
        },
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("sqs.example");
  });

  it("reports an optional DLQ as unavailable instead of inventing depth", async () => {
    const send = vi.fn(async () => ({ Attributes: {} }));
    const queue = new SqsJobQueue(
      "https://sqs.example/main",
      { send } as unknown as SQSClient,
    );

    await expect(queue.getQueueDiagnostics()).resolves.toMatchObject({
      primary: { total: 0 },
      dead_letters: {
        delivery: null,
        scheduler: null,
        inbound: null,
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
