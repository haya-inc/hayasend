import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createOutboxIdentity,
  createProviderEventIdentity,
  deliveryAttemptRecordSchema,
  deliveryMessageRecordSchema,
  deliveryRecordSchema,
  outboxItemRecordSchema,
  providerEventRecordSchema,
  recipientRecordSchema,
  type ProviderReference,
} from "../src/core/delivery-model.js";

const MESSAGE_ID = "email_1234567890abcdef1234567890abcdef";
const RECIPIENT_ID = "rcpt_1234567890abcdef1234567890abcdef";
const ATTEMPT_ID = "attempt_1234567890abcdef1234567890abcdef";
const NOW = "2026-07-26T01:00:00.000Z";
const LATER = "2026-07-26T01:01:00.000Z";
const DIGEST = "0".repeat(64);
const PROVIDER: ProviderReference = {
  name: "aws-ses",
  adapter_version: "0.1.0",
  capability_version: "1.0.0",
};

function messageRecord() {
  return {
    schema_version: "1.0.0",
    record_type: "message",
    id: MESSAGE_ID,
    provider: PROVIDER,
    intent_digest: DIGEST,
    recipient_ids: [RECIPIENT_ID],
    status: "queued",
    created_at: NOW,
    updated_at: NOW,
  } as const;
}

function recipientRecord() {
  return {
    schema_version: "1.0.0",
    record_type: "recipient",
    id: RECIPIENT_ID,
    message_id: MESSAGE_ID,
    role: "bcc",
    ordinal: 0,
    address: "private-recipient@example.test",
    status: "queued",
    created_at: NOW,
    updated_at: NOW,
  } as const;
}

function attemptRecord() {
  return {
    schema_version: "1.0.0",
    record_type: "attempt",
    id: ATTEMPT_ID,
    message_id: MESSAGE_ID,
    recipient_ids: [RECIPIENT_ID],
    sequence: 1,
    provider: PROVIDER,
    status: "accepted",
    provider_message_id: "opaque-provider-message-1",
    started_at: NOW,
    completed_at: LATER,
  } as const;
}

function providerEventRecord() {
  const source = {
    kind: "normalized_event_digest",
    value: "1".repeat(64),
  } as const;
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
    provider_message_id: "opaque-provider-message-1",
    type: "delivered",
    provider_at: NOW,
    received_at: LATER,
    terminal: false,
  } as const;
}

function outboxRecord() {
  return {
    schema_version: "1.0.0",
    record_type: "outbox_item",
    id: createOutboxIdentity({
      message_id: MESSAGE_ID,
      job_type: "dispatch-message",
      generation: 0,
    }),
    message_id: MESSAGE_ID,
    job_type: "dispatch-message",
    generation: 0,
    due_at: NOW,
    attempts: 0,
    created_at: NOW,
    updated_at: NOW,
  } as const;
}

describe("provider-neutral delivery model", () => {
  it("accepts each self-describing record without changing public API types", () => {
    const records = [
      deliveryMessageRecordSchema.parse(messageRecord()),
      recipientRecordSchema.parse(recipientRecord()),
      deliveryAttemptRecordSchema.parse(attemptRecord()),
      providerEventRecordSchema.parse(providerEventRecord()),
      outboxItemRecordSchema.parse(outboxRecord()),
    ];

    expect(records.map((record) => record.record_type)).toEqual([
      "message",
      "recipient",
      "attempt",
      "provider_event",
      "outbox_item",
    ]);
    for (const record of records) {
      expect(deliveryRecordSchema.parse(record)).toEqual(record);
    }
  });

  it("creates stable, unambiguous job and event identities", () => {
    const identities = new Set<string>();
    for (let generation = 0; generation < 200; generation += 1) {
      const input = {
        message_id: MESSAGE_ID,
        job_type: "dispatch-message" as const,
        generation,
      };
      const first = createOutboxIdentity(input);
      const second = createOutboxIdentity(input);
      expect(first).toBe(second);
      identities.add(first);
    }
    expect(identities.size).toBe(200);

    const eventWithSeparator = createProviderEventIdentity({
      provider: "aws-ses",
      source: {
        kind: "provider_event_id",
        value: "opaque:id",
      },
    });
    const eventWithoutSeparator = createProviderEventIdentity({
      provider: "aws-ses",
      source: {
        kind: "provider_event_id",
        value: "opaque%3Aid",
      },
    });
    expect(eventWithSeparator).not.toBe(eventWithoutSeparator);
    expect(eventWithSeparator).toBe(
      createProviderEventIdentity({
        provider: "aws-ses",
        source: {
          kind: "provider_event_id",
          value: "opaque:id",
        },
      }),
    );
  });

  it("keeps addresses out of every durable or public identity", () => {
    const address = recipientRecord().address;
    const serializedIdentities = JSON.stringify({
      recipient_id: recipientRecord().id,
      attempt_id: attemptRecord().id,
      outbox_id: outboxRecord().id,
      provider_event_id: providerEventRecord().id,
    });
    expect(serializedIdentities).not.toContain(address);
    expect(serializedIdentities).not.toContain("@");
    expect(() =>
      createProviderEventIdentity({
        provider: "aws-ses",
        source: {
          kind: "provider_event_id",
          value: address,
        },
      }),
    ).toThrow();
  });

  it("rejects malformed, contradictory, and non-deterministic records", () => {
    expect(() =>
      recipientRecordSchema.parse({
        ...recipientRecord(),
        id: "rcpt_private-recipient@example.test",
      }),
    ).toThrow();
    expect(() =>
      deliveryMessageRecordSchema.parse({
        ...messageRecord(),
        recipient_ids: [RECIPIENT_ID, RECIPIENT_ID],
      }),
    ).toThrow("recipient_ids must be unique");
    expect(() =>
      deliveryMessageRecordSchema.parse({
        ...messageRecord(),
        updated_at: "2026-07-26T00:59:59.000Z",
      }),
    ).toThrow("updated_at cannot be before created_at");
    expect(() =>
      deliveryAttemptRecordSchema.parse({
        ...attemptRecord(),
        status: "retryable_failed",
        diagnostic_category: undefined,
      }),
    ).toThrow("diagnostic_category is required");
    expect(() =>
      providerEventRecordSchema.parse({
        ...providerEventRecord(),
        id: createProviderEventIdentity({
          provider: "another-provider",
          source: providerEventRecord().source,
        }),
      }),
    ).toThrow("identity does not match");
    expect(() =>
      outboxItemRecordSchema.parse({
        ...outboxRecord(),
        lease_owner: "reconciler-1",
      }),
    ).toThrow("lease owner and expiry must be present together");
  });

  it("has no AWS-specific or Node-only runtime import", async () => {
    const source = await readFile(
      new URL("../src/core/delivery-model.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:from|import\()\s*["'](?:node:|@aws-sdk\/)/,
    );
  });
});
