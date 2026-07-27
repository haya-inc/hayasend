import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createMessageBatch,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CloudflareJobEnvelope } from "../../src/adapters/cloudflare/queues-job-queue.js";
import worker, {
  CLOUDFLARE_WORKER_CAPABILITY,
  type HayaSendCloudflareEnv,
} from "../../src/workers/index.js";

class CapturingQueue {
  readonly messages: CloudflareJobEnvelope[] = [];

  async send(body: CloudflareJobEnvelope): Promise<void> {
    this.messages.push(structuredClone(body));
  }
}

function runtimeEnv(
  queue: CapturingQueue,
  overrides: Partial<HayaSendCloudflareEnv> = {},
): HayaSendCloudflareEnv {
  return {
    DB: env.TEST_DB,
    PAYLOADS: env.TEST_BUCKET,
    PRIMARY_QUEUE: queue as unknown as Queue<CloudflareJobEnvelope>,
    EMAIL: {
      async send() {
        return { messageId: "cloudflare-provider-test" };
      },
    },
    HAYASEND_API_KEY: "re_cloudflare_worker_test",
    HAYASEND_DEPLOYMENT_ID: "cloudflare-worker-test",
    HAYASEND_PROVIDER: "cloudflare-email",
    HAYASEND_HEALTH_MODE: "ready",
    PRIMARY_QUEUE_NAME: "test-primary",
    DLQ_QUEUE_NAME: "test-dlq",
    EMAIL_EVENTS_QUEUE_NAME: "test-events",
    ...overrides,
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.TEST_DB, env.TEST_MIGRATIONS);
  await env.TEST_DB.prepare("DELETE FROM emails").run();
});

describe("deployed Cloudflare Worker API boundary", () => {
  it("accepts an unchanged Resend-shaped send and retrieves it", async () => {
    const queue = new CapturingQueue();
    const boundEnv = runtimeEnv(queue);
    const created = await worker.fetch(
      new Request("https://worker.invalid/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer re_cloudflare_worker_test",
          "content-type": "application/json",
          "idempotency-key": "worker-runtime-test",
        },
        body: JSON.stringify({
          from: "sender@example.com",
          to: "recipient@example.net",
          subject: "Cloudflare proof",
          text: "hello",
        }),
      }),
      boundEnv,
    );
    expect(created.status).toBe(200);
    const body = (await created.json()) as { id: string };
    expect(body.id).toMatch(/^email_[a-f0-9]{32}$/);
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]?.job).toMatchObject({
      type: "reconcile_outbox",
    });

    await worker.queue(
      createMessageBatch("test-primary", [
        {
          id: "reconcile-delivery",
          timestamp: new Date(),
          attempts: 1,
          body: queue.messages[0]!,
        },
      ]),
      boundEnv,
    );
    expect(queue.messages[1]?.job).toMatchObject({
      type: "send_email",
      email_id: body.id,
    });

    await worker.queue(
      createMessageBatch("test-primary", [
        {
          id: "send-delivery",
          timestamp: new Date(),
          attempts: 1,
          body: queue.messages[1]!,
        },
      ]),
      boundEnv,
    );

    const retrieved = await worker.fetch(
      new Request(`https://worker.invalid/emails/${body.id}`, {
        headers: {
          authorization: "Bearer re_cloudflare_worker_test",
        },
      }),
      boundEnv,
    );
    expect(retrieved.status).toBe(200);
    await expect(retrieved.json()).resolves.toMatchObject({
      id: body.id,
      status: "sent",
      to: ["recipient@example.net"],
      message_id: "cloudflare-provider-test",
    });
  });

  it("fails the controlled health drill without changing capability truth", async () => {
    const response = await worker.fetch(
      new Request("https://worker.invalid/healthz"),
      runtimeEnv(new CapturingQueue(), {
        HAYASEND_HEALTH_MODE: "fail",
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "failure-drill",
      capability_digest:
        CLOUDFLARE_WORKER_CAPABILITY.capability_digest,
    });
  });

  it("uses durable attempts when Queue delivery counters restart", async () => {
    const queue = new CapturingQueue();
    let providerCalls = 0;
    const boundEnv = runtimeEnv(queue, {
      EMAIL: {
        async send() {
          providerCalls += 1;
          throw Object.assign(new Error("private provider detail"), {
            code: "E_RATE_LIMIT_EXCEEDED",
          });
        },
      },
    });
    const created = await worker.fetch(
      new Request("https://worker.invalid/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer re_cloudflare_worker_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: "sender@example.com",
          to: "recipient@example.net",
          subject: "Durable retries",
          text: "hello",
        }),
      }),
      boundEnv,
    );
    const { id } = (await created.json()) as { id: string };
    await worker.queue(
      createMessageBatch("test-primary", [
        {
          id: "reconcile-delivery",
          timestamp: new Date(),
          attempts: 1,
          body: queue.messages[0]!,
        },
      ]),
      boundEnv,
    );
    const sendJob = queue.messages[1]!;

    for (let delivery = 0; delivery < 3; delivery += 1) {
      await worker.queue(
        createMessageBatch("test-primary", [
          {
            id: `send-delivery-${delivery}`,
            timestamp: new Date(),
            attempts: 1,
            body: sendJob,
          },
        ]),
        boundEnv,
      );
    }

    const retrieved = await worker.fetch(
      new Request(`https://worker.invalid/emails/${id}`, {
        headers: {
          authorization: "Bearer re_cloudflare_worker_test",
        },
      }),
      boundEnv,
    );
    expect(providerCalls).toBe(3);
    const body = await retrieved.json();
    expect(body).toMatchObject({
      id,
      status: "failed",
      error:
        "Email delivery failed (provider_throttled).",
    });
    expect(JSON.stringify(body)).not.toContain(
      "private provider detail",
    );
  });
});
