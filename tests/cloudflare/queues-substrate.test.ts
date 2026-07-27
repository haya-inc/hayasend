import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CloudflareJobQueue,
  consumeCloudflareQueueBatch,
  createCloudflareJobEnvelope,
  recoverCloudflareDeadLetterBatch,
  type CloudflareJobEnvelope,
} from "../../src/adapters/cloudflare/queues-job-queue.js";

class CapturingQueue {
  readonly messages: Array<{
    body: CloudflareJobEnvelope;
    options?: QueueSendOptions | undefined;
  }> = [];
  failure: Error | undefined;

  async send(
    body: CloudflareJobEnvelope,
    options?: QueueSendOptions,
  ): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    this.messages.push({
      body: structuredClone(body),
      ...(options ? { options: structuredClone(options) } : {}),
    });
  }
}

function queueBinding(queue: CapturingQueue): Queue<CloudflareJobEnvelope> {
  return queue as unknown as Queue<CloudflareJobEnvelope>;
}

describe("Cloudflare Queues deterministic delivery", () => {
  it("injects a producer fault before the external Queue call", async () => {
    const capture = new CapturingQueue();
    const queue = new CloudflareJobQueue(queueBinding(capture), {
      fault_injector(point) {
        if (point.operation === "send") {
          throw new Error("injected Queue send failure");
        }
      },
    });

    await expect(
      queue.enqueue({
        type: "send_email",
        email_id: "email_cloudflarequeue0000000000000000",
      }),
    ).rejects.toThrow("injected Queue send failure");
    expect(capture.messages).toEqual([]);
  });

  it("reuses one deterministic identity for duplicate publication", async () => {
    const capture = new CapturingQueue();
    const queue = new CloudflareJobQueue(queueBinding(capture), {
      now: () => new Date("2026-07-27T14:00:00.000Z"),
    });
    const job = {
      type: "send_email" as const,
      email_id: "email_cloudflarequeue0000000000000001",
      job_id:
        "outbox:v1:email_cloudflarequeue0000000000000001:dispatch-message:0",
    };

    await queue.enqueue(job, 30);
    await queue.enqueue(job, 30);

    expect(capture.messages).toHaveLength(2);
    expect(capture.messages[0]?.body.id).toBe(
      capture.messages[1]?.body.id,
    );
    expect(capture.messages[0]?.body.id).toContain(job.job_id);
    expect(capture.messages[0]?.options).toMatchObject({
      contentType: "json",
      delaySeconds: 30,
    });
  });

  it("fails message and delay limits before the external queue call", async () => {
    const capture = new CapturingQueue();
    const faultPoints: string[] = [];
    const queue = new CloudflareJobQueue(queueBinding(capture), {
      fault_injector(point) {
        faultPoints.push(point.operation);
      },
    });

    await expect(
      queue.enqueue({
        type: "send_email",
        email_id: "x".repeat(129_000),
      }),
    ).rejects.toThrow("must not exceed 128000 bytes");
    await expect(
      queue.enqueue(
        {
          type: "send_email",
          email_id: "email_cloudflarequeue0000000000000002",
        },
        86_401,
      ),
    ).rejects.toThrow("between 0 and 86400 seconds");
    expect(capture.messages).toEqual([]);
    expect(faultPoints).toEqual([]);
  });

  it("acknowledges duplicate deliveries only after the handler returns", async () => {
    const envelope = createCloudflareJobEnvelope(
      {
        type: "send_email",
        email_id: "email_cloudflarequeue0000000000000003",
        job_id:
          "outbox:v1:email_cloudflarequeue0000000000000003:dispatch-message:0",
      },
      new Date("2026-07-27T14:00:00.000Z"),
    );
    const batch = createMessageBatch<CloudflareJobEnvelope>(
      "hayasend-jobs",
      [
        {
          id: "delivery-one",
          timestamp: new Date("2026-07-27T14:00:01.000Z"),
          attempts: 1,
          body: envelope,
        },
        {
          id: "delivery-two",
          timestamp: new Date("2026-07-27T14:00:02.000Z"),
          attempts: 2,
          body: envelope,
        },
      ],
    );
    const handled: string[] = [];
    const context = createExecutionContext();

    await consumeCloudflareQueueBatch(batch, async (_job, value) => {
      handled.push(value.id);
    });

    const result = await getQueueResult(batch, context);
    expect(handled).toEqual([envelope.id, envelope.id]);
    expect(result.explicitAcks).toEqual([
      "delivery-one",
      "delivery-two",
    ]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries transient consumer failures without retaining private errors", async () => {
    const envelope = createCloudflareJobEnvelope({
      type: "send_email",
      email_id: "email_cloudflarequeue0000000000000004",
    });
    const batch = createMessageBatch<CloudflareJobEnvelope>(
      "hayasend-jobs",
      [
        {
          id: "delivery-failure",
          timestamp: new Date(),
          attempts: 1,
          body: envelope,
        },
      ],
    );
    const diagnostics: unknown[] = [];
    const context = createExecutionContext();

    await consumeCloudflareQueueBatch(
      batch,
      async () => {
        throw new Error(
          "private recipient@example.net and provider endpoint",
        );
      },
      {
        retry_delay_seconds: 45,
        on_diagnostic(diagnostic) {
          diagnostics.push(diagnostic);
        },
      },
    );

    const result = await getQueueResult(batch, context);
    expect(result.retryMessages).toEqual([
      { msgId: "delivery-failure" },
    ]);
    expect(diagnostics).toEqual([
      {
        job_id: envelope.id,
        category: "application_error",
        source: "primary",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(
      "recipient@example.net",
    );
  });

  it("recovers a DLQ message to the primary queue without changing identity", async () => {
    const envelope = createCloudflareJobEnvelope({
      type: "send_email",
      email_id: "email_cloudflarequeue0000000000000005",
      job_id:
        "outbox:v1:email_cloudflarequeue0000000000000005:dispatch-message:0",
    });
    const batch = createMessageBatch<CloudflareJobEnvelope>(
      "hayasend-jobs-dlq",
      [
        {
          id: "dead-letter-one",
          timestamp: new Date(),
          attempts: 5,
          body: envelope,
        },
      ],
    );
    const primary = new CapturingQueue();
    const context = createExecutionContext();

    await recoverCloudflareDeadLetterBatch(
      batch,
      queueBinding(primary),
    );

    const result = await getQueueResult(batch, context);
    expect(primary.messages).toEqual([
      {
        body: envelope,
        options: { contentType: "json" },
      },
    ]);
    expect(result.explicitAcks).toEqual(["dead-letter-one"]);
  });

  it("retries the DLQ message if re-publication is ambiguous", async () => {
    const envelope = createCloudflareJobEnvelope({
      type: "send_email",
      email_id: "email_cloudflarequeue0000000000000006",
    });
    const batch = createMessageBatch<CloudflareJobEnvelope>(
      "hayasend-jobs-dlq",
      [
        {
          id: "dead-letter-ambiguous",
          timestamp: new Date(),
          attempts: 5,
          body: envelope,
        },
      ],
    );
    const primary = new CapturingQueue();
    primary.failure = new Error("primary queue unavailable");
    const context = createExecutionContext();

    await recoverCloudflareDeadLetterBatch(
      batch,
      queueBinding(primary),
    );

    const result = await getQueueResult(batch, context);
    expect(primary.messages).toEqual([]);
    expect(result.retryMessages).toEqual([
      { msgId: "dead-letter-ambiguous" },
    ]);
  });
});
