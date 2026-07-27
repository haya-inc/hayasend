import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1DeliveryStore } from "../../src/adapters/cloudflare/d1-delivery-store.js";
import type { CloudflareFaultPoint } from "../../src/adapters/cloudflare/fault-injection.js";
import { R2PayloadStorage } from "../../src/adapters/cloudflare/r2-payload-storage.js";
import { sha256Bytes } from "../../src/core/crypto.js";
import type { AttachmentUploadRecord } from "../../src/core/types.js";
import {
  runDeliverySubstrateContract,
  substrateDelivery,
} from "../helpers/delivery-substrate-contract.js";

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
  let cursor: string | undefined;
  do {
    const page = await env.TEST_BUCKET.list({
      ...(cursor ? { cursor } : {}),
    });
    if (page.objects.length > 0) {
      await env.TEST_BUCKET.delete(
        page.objects.map((object) => object.key),
      );
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

runDeliverySubstrateContract(
  "cloudflare-d1-r2",
  () =>
    new D1DeliveryStore(
      env.TEST_DB,
      new R2PayloadStorage(env.TEST_BUCKET, {
        orphan_retention_seconds: 0,
      }),
    ),
);

describe("D1 atomic failure boundaries", () => {
  it.each([
    "email",
    "message",
    "recipient",
    "outbox",
    "ledger-version",
    "idempotency",
    "commit-batch",
  ])("rolls back every delivery row when %s fails", async (target) => {
    const store = new D1DeliveryStore(env.TEST_DB, undefined, {
      fault_injector(point: CloudflareFaultPoint) {
        const matchesWrite =
          point.operation === "commit" && point.target === target;
        const matchesBatch =
          point.operation === "commit-batch" &&
          target === "commit-batch";
        if (matchesWrite || matchesBatch) {
          throw new Error(`injected ${target} failure`);
        }
      },
    });
    const value = substrateDelivery();

    await expect(
      store.commitDelivery(
        value,
        Math.floor(Date.parse(value.email.created_at) / 1_000),
      ),
    ).rejects.toThrow(`injected ${target} failure`);

    const counts = await env.TEST_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM emails) AS emails, (SELECT COUNT(*) FROM delivery_messages) AS messages, (SELECT COUNT(*) FROM delivery_recipients) AS recipients, (SELECT COUNT(*) FROM outbox_items) AS outbox, (SELECT COUNT(*) FROM idempotency_claims) AS idempotency",
    ).first<{
      emails: number;
      messages: number;
      recipients: number;
      outbox: number;
      idempotency: number;
    }>();
    expect(counts).toEqual({
      emails: 0,
      messages: 0,
      recipients: 0,
      outbox: 0,
      idempotency: 0,
    });
  });

  it("fails the recipient limit before any R2 or D1 write", async () => {
    const calls: CloudflareFaultPoint[] = [];
    const storage = new R2PayloadStorage(env.TEST_BUCKET, {
      fault_injector(point) {
        calls.push(point);
      },
    });
    const store = new D1DeliveryStore(env.TEST_DB, storage, {
      fault_injector(point) {
        calls.push(point);
      },
    });
    const value = substrateDelivery();
    value.recipients = Array.from({ length: 51 }, (_, index) => ({
      ...value.recipients[0]!,
      id: `rcpt_${String(index).padStart(32, "0")}`,
      ordinal: index,
      address: `recipient-${index}@example.net`,
    }));
    value.email.to = value.recipients.map(
      (recipient) => recipient.address,
    );
    value.message.recipient_ids = value.recipients.map(
      (recipient) => recipient.id,
    );

    await expect(
      store.commitDelivery(
        value,
        Math.floor(Date.parse(value.email.created_at) / 1_000),
      ),
    ).rejects.toThrow("cannot exceed 50 recipients");
    expect(calls).toEqual([]);
  });
});

describe("R2 integrity, retention, and orphan recovery", () => {
  it("injects an R2 write fault before object persistence", async () => {
    const storage = new R2PayloadStorage(env.TEST_BUCKET, {
      fault_injector(point) {
        if (point.operation === "email-put") {
          throw new Error("injected R2 write failure");
        }
      },
    });
    const value = substrateDelivery();
    const prefix = `emails/${value.email.id}/`;

    await expect(storage.externalizeEmail(value.email)).rejects.toThrow(
      "injected R2 write failure",
    );
    await expect(
      env.TEST_BUCKET.list({ prefix }),
    ).resolves.toMatchObject({ objects: [] });
  });

  it("checks attachment size and SHA-256 on put, head, and read", async () => {
    const storage = new R2PayloadStorage(env.TEST_BUCKET);
    const content = new TextEncoder().encode("attachment-content");
    const record: AttachmentUploadRecord = {
      id: "att_cloudflare00000000000000000001",
      filename: "evidence.txt",
      content_type: "text/plain",
      size_bytes: content.byteLength,
      checksum_sha256: sha256Bytes(content),
      object_key: "attachments/evidence/content",
      upload_token_hash: "0".repeat(64),
      created_at: "2026-07-27T14:00:00.000Z",
      upload_expires_at: "2026-07-27T14:15:00.000Z",
      expires_at: "2026-07-28T14:00:00.000Z",
    };

    await storage.upload(record, content, "text/plain");
    await expect(
      storage.upload(record, content, "text/plain"),
    ).resolves.toBeUndefined();
    const conflictingContent = Uint8Array.from(
      content,
      (byte) => byte ^ 1,
    );
    await expect(
      storage.upload(
        {
          ...record,
          checksum_sha256: sha256Bytes(conflictingContent),
        },
        conflictingContent,
        "text/plain",
      ),
    ).rejects.toThrow("already exists with different content");
    await expect(storage.verify(record)).resolves.toBeUndefined();
    await expect(storage.read(record)).resolves.toEqual(content);
    const object = await env.TEST_BUCKET.head(record.object_key);
    expect(object?.customMetadata).toMatchObject({
      "hayasend-managed": "true",
      "hayasend-kind": "attachment",
      "hayasend-sha256": record.checksum_sha256,
    });
    expect(object?.checksums.sha256).toBeInstanceOf(ArrayBuffer);
  });

  it("rejects an oversized payload before R2 persistence", async () => {
    const storage = new R2PayloadStorage(env.TEST_BUCKET, {
      max_payload_bytes: 8,
    });
    const value = substrateDelivery();
    value.email.text = "larger than eight bytes";

    await expect(
      storage.externalizeEmail(value.email),
    ).rejects.toThrow("must not exceed 8 bytes");
    await expect(
      env.TEST_BUCKET.list({ prefix: `emails/${value.email.id}/` }),
    ).resolves.toMatchObject({ objects: [] });
  });

  it("recovers with a new key and removes only the failed D1 commit orphan", async () => {
    const storage = new R2PayloadStorage(env.TEST_BUCKET, {
      orphan_retention_seconds: 0,
    });
    const store = new D1DeliveryStore(env.TEST_DB, storage, {
      fault_injector(point) {
        if (point.operation === "commit-batch") {
          throw new Error("D1 unavailable after R2 accepted the payload");
        }
      },
    });
    const value = substrateDelivery();
    const prefix = `emails/${value.email.id}/`;

    await expect(
      store.commitDelivery(
        value,
        Math.floor(Date.parse(value.email.created_at) / 1_000),
      ),
    ).rejects.toThrow("D1 unavailable");
    const orphanPage = await env.TEST_BUCKET.list({ prefix });
    expect(orphanPage.objects).toHaveLength(1);
    const orphanKey = orphanPage.objects[0]!.key;

    const recoveredStore = new D1DeliveryStore(env.TEST_DB, storage);
    await expect(
      recoveredStore.commitDelivery(
        value,
        Math.floor(Date.parse(value.email.created_at) / 1_000),
      ),
    ).resolves.toMatchObject({ replayed: false });
    const referencedKeys =
      await recoveredStore.listReferencedPayloadKeys();
    expect(referencedKeys.size).toBe(1);
    const [referencedKey] = referencedKeys;
    expect(referencedKey).not.toBe(orphanKey);

    const result = await storage.sweepOrphans({
      referenced_keys: referencedKeys,
      now: new Date("2026-07-28T14:00:00.000Z"),
      prefix,
    });
    expect(result).toMatchObject({
      scanned: 2,
      deleted: [orphanKey],
      truncated: false,
    });
    await expect(env.TEST_BUCKET.head(orphanKey)).resolves.toBeNull();
    await expect(
      env.TEST_BUCKET.head(referencedKey!),
    ).resolves.not.toBeNull();
  });
});
