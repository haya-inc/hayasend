import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1DeliveryStore } from "../../src/adapters/cloudflare/d1-delivery-store.js";
import type { CloudflareJobEnvelope } from "../../src/adapters/cloudflare/queues-job-queue.js";
import { R2PayloadStorage } from "../../src/adapters/cloudflare/r2-payload-storage.js";
import worker, {
  type CloudflareBackupRestoreProbeEnv,
} from "../../src/workers/cloudflare-backup-restore-probe.js";
import {
  substrateDelivery,
} from "../helpers/delivery-substrate-contract.js";

const TOKEN = "re_cloudflare_backup_restore_probe";

class CapturingQueue {
  readonly messages: CloudflareJobEnvelope[] = [];

  async send(body: CloudflareJobEnvelope): Promise<void> {
    this.messages.push(structuredClone(body));
  }
}

async function clearBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      ...(cursor ? { cursor } : {}),
    });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function request(body: unknown): Request {
  return new Request("https://probe.invalid/", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.TEST_DB, env.TEST_MIGRATIONS);
  await env.TEST_DB.batch([
    env.TEST_DB.prepare("DELETE FROM emails"),
    env.TEST_DB.prepare(
      "UPDATE provider_event_metrics SET latest_received_at = NULL WHERE singleton = 1",
    ),
    env.TEST_DB.prepare(
      "UPDATE outbox_metrics SET publish_failures_total = 0 WHERE singleton = 1",
    ),
  ]);
  await Promise.all([
    clearBucket(env.TEST_BUCKET),
    clearBucket(env.TEST_TARGET_BUCKET),
  ]);
});

describe("Cloudflare isolated backup and restore probe", () => {
  it("copies managed payloads, matches the restored digest, and recovers due work once", async () => {
    const store = new D1DeliveryStore(
      env.TEST_DB,
      new R2PayloadStorage(env.TEST_BUCKET),
    );
    const sent = substrateDelivery(
      `${"a".repeat(31)}1`,
    );
    const scheduled = substrateDelivery(
      `${"a".repeat(31)}2`,
    );
    scheduled.email.status = "scheduled";
    scheduled.email.last_event = "scheduled";
    scheduled.email.scheduled_at = "2030-01-01T00:00:00.000Z";
    scheduled.email.updated_at = scheduled.email.created_at;
    scheduled.message.status = "scheduled";
    scheduled.message.scheduled_at = scheduled.email.scheduled_at;
    scheduled.outbox.due_at = scheduled.email.scheduled_at;
    scheduled.idempotency!.key_hash = "2".repeat(64);

    const now = new Date(sent.email.created_at);
    await store.commitDelivery(
      sent,
      Math.floor(now.getTime() / 1_000),
    );
    const [leased] = await store.leaseDueOutbox({
      owner: "fixture-dispatcher",
      now,
      lease_seconds: 60,
      limit: 1,
    });
    await store.acknowledgeOutbox(
      leased!.id,
      "fixture-dispatcher",
      now,
    );
    await store.beginDeliveryAttempt({
      schema_version: "1.0.0",
      record_type: "attempt",
      id: "attempt_cloudflarebackuprestore0000001",
      message_id: sent.message.id,
      recipient_ids: [...sent.message.recipient_ids],
      sequence: 1,
      provider: sent.message.provider,
      status: "submitting",
      started_at: "2026-07-27T14:00:01.000Z",
    });
    await store.completeDeliveryAttempt({
      message_id: sent.message.id,
      attempt_id: "attempt_cloudflarebackuprestore0000001",
      status: "accepted",
      provider_message_id: "cloudflare-backup-restore-fixture",
      completed_at: "2026-07-27T14:00:02.000Z",
    });
    await store.commitDelivery(
      scheduled,
      Math.floor(now.getTime() / 1_000),
    );

    const sourceEnv: CloudflareBackupRestoreProbeEnv = {
      DB: env.TEST_DB,
      PAYLOADS: env.TEST_BUCKET,
      TARGET_PAYLOADS: env.TEST_TARGET_BUCKET,
      HAYASEND_PROOF_TOKEN: TOKEN,
      HAYASEND_PROOF_MODE: "source",
    };
    const snapshotResponse = await worker.fetch(
      request({
        action: "snapshot",
        sent_email_id: sent.email.id,
        scheduled_email_id: scheduled.email.id,
      }),
      sourceEnv,
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      state_sha256: string;
    };
    expect(snapshot.state_sha256).toMatch(/^[a-f0-9]{64}$/);

    const queue = new CapturingQueue();
    const restoreEnv: CloudflareBackupRestoreProbeEnv = {
      DB: env.TEST_DB,
      PAYLOADS: env.TEST_TARGET_BUCKET,
      RECOVERY_QUEUE:
        queue as unknown as Queue<CloudflareJobEnvelope>,
      HAYASEND_PROOF_TOKEN: TOKEN,
      HAYASEND_PROOF_MODE: "restore",
    };
    const restoreResponse = await worker.fetch(
      request({
        action: "verify",
        expected_state_sha256: snapshot.state_sha256,
        scheduled_email_id: scheduled.email.id,
      }),
      restoreEnv,
    );
    expect(restoreResponse.status).toBe(200);
    const evidence = await restoreResponse.json();
    expect(evidence).toMatchObject({
      object: "cloudflare_backup_restore_proof",
      status: "passed",
      relational_integrity: "passed",
      payload_integrity: "passed",
      hydration: "passed",
      due_work_recovery: {
        first_sweep: { leased: 1, dispatched: 1, failed: 0 },
        second_sweep: { leased: 0, dispatched: 0, failed: 0 },
        deterministic_single_dispatch: true,
      },
      immutable_delivery_ledger_unchanged: true,
      external_send_performed_during_restore: false,
    });
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]?.job).toMatchObject({
      type: "send_email",
      email_id: scheduled.email.id,
      job_id: scheduled.outbox.id,
    });
    expect(JSON.stringify(evidence)).not.toContain("Private subject");
    expect(JSON.stringify(evidence)).not.toContain(
      "recipient@example.net",
    );

    const cleanup = await worker.fetch(
      request({ action: "purge_restore_payloads" }),
      restoreEnv,
    );
    expect(cleanup.status).toBe(200);
    await expect(cleanup.json()).resolves.toMatchObject({
      object: "cloudflare_backup_restore_cleanup",
      complete: true,
      deleted_payload_objects: 2,
    });
    await expect(
      env.TEST_TARGET_BUCKET.list(),
    ).resolves.toMatchObject({ objects: [] });
  });

  it("fails closed without exposing proof details", async () => {
    const response = await worker.fetch(
      new Request("https://probe.invalid/", {
        method: "POST",
        body: JSON.stringify({ action: "snapshot" }),
      }),
      {
        DB: env.TEST_DB,
        PAYLOADS: env.TEST_BUCKET,
        HAYASEND_PROOF_TOKEN: TOKEN,
        HAYASEND_PROOF_MODE: "source",
      },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      object: "cloudflare_backup_restore_proof",
      status: "failed",
      name: "proof_failed",
    });
  });
});
