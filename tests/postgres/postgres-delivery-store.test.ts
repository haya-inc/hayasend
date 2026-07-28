import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgresDeliveryMigration from "../../migrations/postgres/0001_delivery.sql?raw";
import { PostgresDeliveryStore } from "../../src/adapters/postgres/postgres-delivery-store.js";
import {
  runDeliverySubstrateContract,
  substrateDelivery,
} from "../helpers/delivery-substrate-contract.js";

const databaseUrl = process.env.HAYASEND_POSTGRES_TEST_URL;

if (!databaseUrl) {
  describe.skip("PostgreSQL delivery substrate", () => {
    it("requires HAYASEND_POSTGRES_TEST_URL", () => {});
  });
} else {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 12,
  });
  beforeAll(async () => {
    const existing = await pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.delivery_messages')::text AS table_name",
    );
    if (!existing.rows[0]?.table_name) {
      await pool.query(postgresDeliveryMigration);
    }
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE
         provider_events,
         delivery_attempts,
         outbox_items,
         idempotency_claims,
         delivery_recipients,
         delivery_messages,
         emails
       RESTART IDENTITY CASCADE`,
    );
    await pool.query(
      "UPDATE provider_event_metrics SET latest_received_at = NULL WHERE singleton = true",
    );
    await pool.query(
      "UPDATE outbox_metrics SET publish_failures_total = 0 WHERE singleton = true",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  runDeliverySubstrateContract(
    "postgresql-18",
    () => new PostgresDeliveryStore(pool),
  );

  describe("PostgreSQL atomic delivery boundary", () => {
    it("reports an empty durable outbox without special casing", async () => {
      const store = new PostgresDeliveryStore(pool);

      await expect(
        store.getOutboxMetrics(new Date("2026-07-27T14:00:00.000Z")),
      ).resolves.toEqual({
        due: 0,
        leased: 0,
        stuck_leases: 0,
        undispatched: 0,
        oldest_due_age_seconds: 0,
        publish_failures_total: 0,
        truncated: false,
      });
    });

    it("rolls back every row when a recipient identity conflicts", async () => {
      const store = new PostgresDeliveryStore(pool);
      const first = substrateDelivery("postgresatomic000000000000000001");
      const conflicting = substrateDelivery("postgresatomic000000000000000002");
      conflicting.recipients[0] = {
        ...conflicting.recipients[0]!,
        id: first.recipients[0]!.id,
      };
      conflicting.message.recipient_ids = [first.recipients[0]!.id];
      conflicting.idempotency = {
        ...conflicting.idempotency!,
        key_hash: "2".repeat(64),
      };

      await store.commitDelivery(
        first,
        Math.floor(Date.parse(first.email.created_at) / 1_000),
      );
      await expect(
        store.commitDelivery(
          conflicting,
          Math.floor(Date.parse(conflicting.email.created_at) / 1_000),
        ),
      ).rejects.toThrow("Delivery identity is already in use");

      await expect(
        store.getDelivery(conflicting.message.id),
      ).resolves.toBeUndefined();
      const result = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM outbox_items",
      );
      expect(result.rows[0]?.count).toBe("1");
    });
  });
}
