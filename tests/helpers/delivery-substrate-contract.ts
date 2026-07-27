import { describe, expect, it } from "vitest";
import {
  createOutboxIdentity,
  createProviderEventIdentity,
  type DeliveryAttemptRecord,
  type ProviderEventRecord,
  type ProviderReference,
} from "../../src/core/delivery-model.js";
import type { DeliveryCommit } from "../../src/core/delivery-commit.js";
import type { DeliveryOutboxStore } from "../../src/ports/delivery-outbox-store.js";
import type { DeliveryLedgerStore } from "../../src/ports/delivery-ledger-store.js";

export type DeliverySubstrate =
  & DeliveryOutboxStore
  & DeliveryLedgerStore;

const CREATED_AT = "2026-07-27T14:00:00.000Z";
const MESSAGE_ID = "email_cloudflarecontract00000000000001";
const RECIPIENT_ID = "rcpt_cloudflarecontract00000000000001";
const ATTEMPT_ID = "attempt_cloudflarecontract000000000001";
const PROVIDER: ProviderReference = {
  name: "cloudflare-email",
  adapter_version: "0.1.0",
  capability_version: "1.0.0",
};

export function substrateDelivery(
  seed = "cloudflarecontract00000000000001",
): DeliveryCommit {
  const messageId = `email_${seed}`;
  const recipientId = `rcpt_${seed}`;
  const timestamp = CREATED_AT;
  const digest = "0".repeat(64);
  return {
    email: {
      id: messageId,
      from: "sender@example.com",
      to: ["recipient@example.net"],
      subject: "Private subject",
      text: "Private body",
      status: "queued",
      last_event: "queued",
      created_at: timestamp,
      updated_at: timestamp,
      request_hash: digest,
      attempts: 0,
    },
    message: {
      schema_version: "1.0.0",
      record_type: "message",
      id: messageId,
      provider: PROVIDER,
      intent_digest: digest,
      recipient_ids: [recipientId],
      status: "queued",
      created_at: timestamp,
      updated_at: timestamp,
    },
    recipients: [
      {
        schema_version: "1.0.0",
        record_type: "recipient",
        id: recipientId,
        message_id: messageId,
        role: "to",
        ordinal: 0,
        address: "recipient@example.net",
        status: "queued",
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    outbox: {
      schema_version: "1.0.0",
      record_type: "outbox_item",
      id: createOutboxIdentity({
        message_id: messageId,
        job_type: "dispatch-message",
        generation: 0,
      }),
      message_id: messageId,
      job_type: "dispatch-message",
      generation: 0,
      due_at: timestamp,
      attempts: 0,
      created_at: timestamp,
      updated_at: timestamp,
    },
    idempotency: {
      key_hash: "1".repeat(64),
      request_hash: digest,
      expires_at: Math.floor(Date.parse(timestamp) / 1_000) + 86_400,
    },
  };
}

function attempt(): DeliveryAttemptRecord {
  return {
    schema_version: "1.0.0",
    record_type: "attempt",
    id: ATTEMPT_ID,
    message_id: MESSAGE_ID,
    recipient_ids: [RECIPIENT_ID],
    sequence: 1,
    provider: PROVIDER,
    status: "submitting",
    started_at: "2026-07-27T14:00:01.000Z",
  };
}

function event(
  sequence: number,
  type: ProviderEventRecord["type"],
): ProviderEventRecord {
  const source = {
    kind: "provider_event_id" as const,
    value: `cloudflare-event-${sequence}`,
  };
  return {
    schema_version: "1.0.0",
    record_type: "provider_event",
    id: createProviderEventIdentity({
      provider: PROVIDER.name,
      source,
    }),
    provider: PROVIDER,
    source,
    message_id: MESSAGE_ID,
    attempt_id: ATTEMPT_ID,
    recipient_ids: [RECIPIENT_ID],
    provider_message_id: "cloudflare-provider-message-1",
    type,
    provider_at: new Date(
      Date.parse(CREATED_AT) + (20 - sequence) * 1_000,
    ).toISOString(),
    received_at: new Date(
      Date.parse(CREATED_AT) + (sequence + 3) * 1_000,
    ).toISOString(),
    terminal: [
      "delivered",
      "bounced",
      "complained",
      "rejected",
      "failed",
    ].includes(type),
  };
}

async function acceptedStore(
  factory: () => DeliverySubstrate | Promise<DeliverySubstrate>,
): Promise<DeliverySubstrate> {
  const store = await factory();
  const value = substrateDelivery();
  await store.commitDelivery(
    value,
    Math.floor(Date.parse(CREATED_AT) / 1_000),
  );
  await store.beginDeliveryAttempt(attempt());
  await store.completeDeliveryAttempt({
    message_id: MESSAGE_ID,
    attempt_id: ATTEMPT_ID,
    status: "accepted",
    provider_message_id: "cloudflare-provider-message-1",
    completed_at: "2026-07-27T14:00:02.000Z",
  });
  return store;
}

export function runDeliverySubstrateContract(
  name: string,
  factory: () => DeliverySubstrate | Promise<DeliverySubstrate>,
): void {
  describe(`${name} shared delivery-substrate contract`, () => {
    it("atomically replays one delivery and gives one owner its outbox lease", async () => {
      const store = await factory();
      const value = substrateDelivery();
      const now = new Date(CREATED_AT);
      await expect(
        store.commitDelivery(
          value,
          Math.floor(now.getTime() / 1_000),
        ),
      ).resolves.toMatchObject({ replayed: false });
      await expect(
        store.commitDelivery(
          value,
          Math.floor(now.getTime() / 1_000),
        ),
      ).resolves.toMatchObject({
        replayed: true,
        email: { id: value.email.id },
      });

      const [left, right] = await Promise.all([
        store.leaseDueOutbox({
          owner: "contract-left",
          now,
          lease_seconds: 60,
          limit: 10,
        }),
        store.leaseDueOutbox({
          owner: "contract-right",
          now,
          lease_seconds: 60,
          limit: 10,
        }),
      ]);
      expect(left.length + right.length).toBe(1);
      const leased = [...left, ...right][0]!;
      expect(leased.attempts).toBe(1);
      await expect(
        store.acknowledgeOutbox(
          leased.id,
          leased.lease_owner === "contract-left"
            ? "contract-right"
            : "contract-left",
          now,
        ),
      ).resolves.toBe(false);
      await expect(
        store.acknowledgeOutbox(
          leased.id,
          leased.lease_owner!,
          now,
        ),
      ).resolves.toBe(true);
      await expect(store.getOutboxMetrics(now)).resolves.toMatchObject({
        due: 0,
        undispatched: 0,
      });
    });

    it("converges duplicate, out-of-order, and concurrent lifecycle evidence", async () => {
      const store = await acceptedStore(factory);
      const delivered = event(1, "delivered");
      await expect(
        store.appendProviderEvent(delivered),
      ).resolves.toMatchObject({ replayed: false });
      await expect(
        store.appendProviderEvent({
          ...delivered,
          received_at: "2026-07-27T14:00:59.000Z",
        }),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        store.appendProviderEvent({ ...delivered, type: "bounced" }),
      ).rejects.toThrow("different normalized event");

      await Promise.all([
        store.appendProviderEvent(event(2, "opened")),
        store.appendProviderEvent(event(3, "clicked")),
        store.appendProviderEvent(event(4, "delayed")),
      ]);
      const ledger = await store.getDeliveryLedger(MESSAGE_ID);
      expect(ledger?.recipients[0]?.status).toBe("clicked");
      expect(ledger?.events.map((item) => item.type)).toEqual([
        "delivered",
        "opened",
        "clicked",
        "delayed",
      ]);
      expect(JSON.stringify(ledger?.events)).not.toContain(
        "recipient@example.net",
      );
    });

    it("keeps local suppression sticky against later provider evidence", async () => {
      const store = await acceptedStore(factory);
      await store.applyLocalDeliveryState(
        MESSAGE_ID,
        "suppressed",
        "2026-07-27T14:00:03.000Z",
      );
      await store.appendProviderEvent(event(1, "delivered"));
      await expect(
        store.getDeliveryLedger(MESSAGE_ID),
      ).resolves.toMatchObject({
        email: { status: "suppressed" },
        message: { status: "suppressed" },
        recipients: [{ status: "suppressed" }],
      });
    });

    it("releases a failed outbox lease without retaining private error text", async () => {
      const store = await factory();
      const value = substrateDelivery(
        "cloudflarecontract00000000000002",
      );
      const now = new Date(CREATED_AT);
      await store.commitDelivery(
        value,
        Math.floor(now.getTime() / 1_000),
      );
      const [leased] = await store.leaseDueOutbox({
        owner: "contract-failure",
        now,
        lease_seconds: 60,
        limit: 10,
      });
      await expect(
        store.recordOutboxFailure(
          leased!.id,
          "contract-failure",
          "provider_unavailable",
          now,
        ),
      ).resolves.toBe(true);
      const retained = await store.getOutboxItem(leased!.id);
      expect(retained).toMatchObject({
        last_diagnostic_category: "provider_unavailable",
      });
      expect(retained?.lease_owner).toBeUndefined();
      expect(JSON.stringify(retained)).not.toContain("recipient@example.net");
      await expect(store.getOutboxMetrics(now)).resolves.toMatchObject({
        due: 1,
        undispatched: 1,
        publish_failures_total: 1,
      });
    });
  });
}
