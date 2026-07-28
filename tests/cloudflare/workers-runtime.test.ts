import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CloudflareJobEnvelope } from "../../src/adapters/cloudflare/queues-job-queue.js";
import worker, {
  CLOUDFLARE_WORKER_CAPABILITY,
  type HayaSendCloudflareEnv,
} from "../../src/workers/index.js";

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
        return {
          messageId: "<cloudflare-provider-test@hayasend.com>",
        };
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
    expect(queue.messages[0]?.body.job).toMatchObject({
      type: "reconcile_outbox",
    });

    await worker.queue(
      createMessageBatch("test-primary", [
        {
          id: "reconcile-delivery",
          timestamp: new Date(),
          attempts: 1,
          body: queue.messages[0]!.body,
        },
      ]),
      boundEnv,
    );
    expect(queue.messages[1]?.body.job).toMatchObject({
      type: "send_email",
      email_id: body.id,
    });

    await worker.queue(
      createMessageBatch("test-primary", [
        {
          id: "send-delivery",
          timestamp: new Date(),
          attempts: 1,
          body: queue.messages[1]!.body,
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
      message_id: "<cloudflare-provider-test@hayasend.com>",
    });

    const recipients = await worker.fetch(
      new Request(
        `https://worker.invalid/emails/${body.id}/recipients?limit=1`,
        {
          headers: {
            authorization: "Bearer re_cloudflare_worker_test",
          },
        },
      ),
      boundEnv,
    );
    expect(recipients.status).toBe(200);
    await expect(recipients.json()).resolves.toMatchObject({
      object: "list",
      message_id: body.id,
      aggregate_status: "accepted",
      recipient_count: 1,
      has_more: false,
      attempt_summary: { accepted: 1 },
      data: [
        {
          role: "to",
          ordinal: 0,
          status: "accepted",
          recovery_state: "awaiting_event",
        },
      ],
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
          body: queue.messages[0]!.body,
        },
      ]),
      boundEnv,
    );
    const sendJob = queue.messages[1]!.body;

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

  it("recovers a lost scheduler wake-up from the durable D1 outbox", async () => {
    const failedQueue = new CapturingQueue();
    failedQueue.failure = new Error("injected scheduler wake-up loss");
    const created = await worker.fetch(
      new Request("https://worker.invalid/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer re_cloudflare_worker_test",
          "content-type": "application/json",
          "idempotency-key": "worker-wakeup-loss",
        },
        body: JSON.stringify({
          from: "sender@example.com",
          to: "recipient@example.net",
          subject: "Durable wake-up recovery",
          text: "hello",
        }),
      }),
      runtimeEnv(failedQueue),
    );
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect(failedQueue.messages).toEqual([]);

    const recoveredQueue = new CapturingQueue();
    const context = createExecutionContext();
    await worker.scheduled!(
      createScheduledController({
        scheduledTime: Date.now(),
        cron: "*/5 * * * *",
      }),
      runtimeEnv(recoveredQueue, {
        HAYASEND_DEPLOYMENT_ID: "cloudflare-worker-redeployed",
      }),
      context,
    );
    await waitOnExecutionContext(context);

    expect(recoveredQueue.messages).toHaveLength(1);
    expect(recoveredQueue.messages[0]?.body.job).toMatchObject({
      type: "send_email",
      email_id: id,
      job_id: expect.stringMatching(
        /^outbox:v1:email_[^:]+:dispatch-message:0$/,
      ),
    });
  });

  it("recovers a 30-day schedule after redeploy beyond the native queue delay", async () => {
    const initialQueue = new CapturingQueue();
    const scheduledAt = new Date(
      Date.now() + 30 * 86_400_000 - 60_000,
    ).toISOString();
    const created = await worker.fetch(
      new Request("https://worker.invalid/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer re_cloudflare_worker_test",
          "content-type": "application/json",
          "idempotency-key": "worker-long-delay",
        },
        body: JSON.stringify({
          from: "sender@example.com",
          to: "recipient@example.net",
          subject: "Durable long schedule",
          text: "hello",
          scheduled_at: scheduledAt,
        }),
      }),
      runtimeEnv(initialQueue),
    );
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect(initialQueue.messages).toHaveLength(1);
    expect(initialQueue.messages[0]).toMatchObject({
      body: { job: { type: "reconcile_outbox" } },
      options: { delaySeconds: 900 },
    });

    const row = await env.TEST_DB.prepare(
      "SELECT id, entity FROM outbox_items WHERE message_id = ?",
    )
      .bind(id)
      .first<{ id: string; entity: string }>();
    expect(row).toBeTruthy();
    const dueAt = new Date(Date.now() - 1).toISOString();
    const updatedAt = new Date().toISOString();
    const entity = JSON.parse(row!.entity) as Record<string, unknown>;
    entity.due_at = dueAt;
    entity.updated_at = updatedAt;
    await env.TEST_DB.prepare(
      "UPDATE outbox_items SET due_at = ?, entity = ?, updated_at = ? WHERE id = ?",
    )
      .bind(dueAt, JSON.stringify(entity), updatedAt, row!.id)
      .run();

    const recoveredQueue = new CapturingQueue();
    const context = createExecutionContext();
    await worker.scheduled!(
      createScheduledController({
        scheduledTime: Date.now(),
        cron: "*/5 * * * *",
      }),
      runtimeEnv(recoveredQueue, {
        HAYASEND_DEPLOYMENT_ID: "cloudflare-worker-long-delay-redeploy",
      }),
      context,
    );
    await waitOnExecutionContext(context);

    expect(recoveredQueue.messages).toHaveLength(1);
    expect(recoveredQueue.messages[0]?.body.job).toMatchObject({
      type: "send_email",
      email_id: id,
      job_id: row!.id,
    });
  });
});
