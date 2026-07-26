import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoStore } from "../src/adapters/dynamo-store.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import {
  createOutboxIdentity,
  createProviderEventIdentity,
  type DeliveryAttemptRecord,
  type ProviderEventRecord,
  type ProviderReference,
  type RecipientRecord,
} from "../src/core/delivery-model.js";
import type { DeliveryCommit } from "../src/core/delivery-commit.js";
import type { Store } from "../src/ports/store.js";

const MESSAGE_ID = "email_ledgercontract000000000000000001";
const RECIPIENT_A = "rcpt_ledgercontract000000000000000001";
const RECIPIENT_B = "rcpt_ledgercontract000000000000000002";
const ATTEMPT_ID = "attempt_ledgercontract0000000000000001";
const CREATED_AT = "2026-07-26T02:00:00.000Z";
const PROVIDER: ProviderReference = {
  name: "aws-ses",
  adapter_version: "0.1.0",
  capability_version: "1.0.0",
};

function transactionCanceled(): Error {
  const error = new Error("transaction canceled");
  error.name = "TransactionCanceledException";
  return error;
}

class TransactionalDynamoMemory {
  private items = new Map<string, Record<string, unknown>>();
  private ledgerQueryBarrier: Promise<void> | undefined;
  private releaseLedgerQueryBarrier: (() => void) | undefined;
  private ledgerQueriesRemaining = 0;
  transactionCancellations = 0;

  pauseNextLedgerQueries(count: number): void {
    this.ledgerQueriesRemaining = count;
    this.ledgerQueryBarrier = new Promise((resolve) => {
      this.releaseLedgerQueryBarrier = resolve;
    });
  }

  readonly client = {
    send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        const next = new Map(
          [...this.items].map(([key, value]) => [
            key,
            structuredClone(value),
          ]),
        );
        for (const action of command.input.TransactItems ?? []) {
          if (action.Put) {
            const item = structuredClone(
              action.Put.Item as Record<string, unknown>,
            );
            const key = this.key(item);
            if (
              action.Put.ConditionExpression ===
                "attribute_not_exists(PK)" &&
              next.has(key)
            ) {
              this.transactionCancellations += 1;
              throw transactionCanceled();
            }
            next.set(key, item);
          } else if (action.Update) {
            const key = this.key(
              action.Update.Key as Record<string, unknown>,
            );
            const current = next.get(key);
            if (!current) {
              if (
                action.Update.UpdateExpression?.includes(
                  "ADD undispatched",
                )
              ) {
                next.set(key, {
                  ...(action.Update.Key as Record<string, unknown>),
                  undispatched: 1,
                });
                continue;
              }
              this.transactionCancellations += 1;
              throw transactionCanceled();
            }
            if (action.Update.UpdateExpression === "SET entity = :next") {
              const values = action.Update
                .ExpressionAttributeValues as Record<string, unknown>;
              if (
                JSON.stringify(current.entity) !==
                JSON.stringify(values[":expected"])
              ) {
                this.transactionCancellations += 1;
                throw transactionCanceled();
              }
              next.set(key, {
                ...current,
                entity: structuredClone(values[":next"]),
              });
            } else if (
              action.Update.UpdateExpression?.includes(
                "ADD undispatched",
              )
            ) {
              const currentCount =
                typeof current.undispatched === "number"
                  ? current.undispatched
                  : 0;
              next.set(key, {
                ...current,
                undispatched: currentCount + 1,
              });
            } else {
              throw new Error(
                `Unsupported test update: ${action.Update.UpdateExpression}`,
              );
            }
          } else if (action.ConditionCheck) {
            const key = this.key(
              action.ConditionCheck.Key as Record<string, unknown>,
            );
            const current = next.get(key);
            const expected = (
              action.ConditionCheck
                .ExpressionAttributeValues as Record<string, unknown>
            )[":expected"];
            if (
              !current ||
              JSON.stringify(current.entity) !== JSON.stringify(expected)
            ) {
              this.transactionCancellations += 1;
              throw transactionCanceled();
            }
          }
        }
        this.items = next;
        return {};
      }
      if (command instanceof QueryCommand) {
        const values = command.input
          .ExpressionAttributeValues as Record<string, unknown>;
        const partition = values[":partition"];
        const all = [...this.items.values()];
        const matches = command.input.IndexName
          ? all.filter((item) => item.GSI1PK === partition)
          : all.filter((item) => item.PK === partition);
        if (
          !command.input.IndexName &&
          this.ledgerQueryBarrier &&
          this.ledgerQueriesRemaining > 0
        ) {
          const barrier = this.ledgerQueryBarrier;
          this.ledgerQueriesRemaining -= 1;
          if (this.ledgerQueriesRemaining === 0) {
            this.releaseLedgerQueryBarrier?.();
            this.ledgerQueryBarrier = undefined;
            this.releaseLedgerQueryBarrier = undefined;
          }
          await barrier;
        }
        return {
          Items: matches.sort((left, right) =>
            String(
              command.input.IndexName ? left.GSI1SK : left.SK,
            ).localeCompare(
              String(
                command.input.IndexName ? right.GSI1SK : right.SK,
              ),
            ),
          ),
        };
      }
      if (command instanceof GetCommand) {
        const item = this.items.get(
          this.key(command.input.Key as Record<string, unknown>),
        );
        return item ? { Item: structuredClone(item) } : {};
      }
      throw new Error(
        `Unsupported DynamoDB test command: ${String(command)}`,
      );
    },
  } as unknown as DynamoDBDocumentClient;

  private key(item: Record<string, unknown>): string {
    return `${String(item.PK)}|${String(item.SK)}`;
  }
}

function delivery(recipientCount = 1): DeliveryCommit {
  const recipientInputs = [
    {
      id: RECIPIENT_A,
      address: "first-recipient@example.net",
      ordinal: 0,
    },
    {
      id: RECIPIENT_B,
      address: "second-recipient@example.net",
      ordinal: 1,
    },
  ].slice(0, recipientCount);
  const recipients: RecipientRecord[] = recipientInputs.map((recipient) => ({
    schema_version: "1.0.0",
    record_type: "recipient",
    id: recipient.id,
    message_id: MESSAGE_ID,
    role: "to",
    ordinal: recipient.ordinal,
    address: recipient.address,
    status: "queued",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  }));
  return {
    email: {
      id: MESSAGE_ID,
      from: "sender@example.com",
      to: recipients.map((recipient) => recipient.address),
      subject: "Private subject must not enter provider events",
      text: "Private body must not enter provider events",
      status: "queued",
      last_event: "queued",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      request_hash: "0".repeat(64),
      attempts: 0,
    },
    message: {
      schema_version: "1.0.0",
      record_type: "message",
      id: MESSAGE_ID,
      provider: PROVIDER,
      intent_digest: "0".repeat(64),
      recipient_ids: recipients.map((recipient) => recipient.id),
      status: "queued",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    recipients,
    outbox: {
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
      due_at: CREATED_AT,
      attempts: 0,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
  };
}

async function acceptedStore(
  factory: () => Store,
  recipientCount = 1,
): Promise<Store> {
  const store = factory();
  const value = delivery(recipientCount);
  await store.commitDelivery(
    value,
    Math.floor(Date.parse(CREATED_AT) / 1_000),
  );
  const attempt: DeliveryAttemptRecord = {
    schema_version: "1.0.0",
    record_type: "attempt",
    id: ATTEMPT_ID,
    message_id: MESSAGE_ID,
    recipient_ids: value.message.recipient_ids,
    sequence: 1,
    provider: PROVIDER,
    status: "submitting",
    started_at: "2026-07-26T02:00:01.000Z",
  };
  await store.beginDeliveryAttempt(attempt);
  await store.completeDeliveryAttempt({
    message_id: MESSAGE_ID,
    attempt_id: ATTEMPT_ID,
    status: "accepted",
    provider_message_id: "ses-provider-message-1",
    completed_at: "2026-07-26T02:00:02.000Z",
  });
  return store;
}

function event(
  sequence: number,
  type: ProviderEventRecord["type"],
  recipientIds = [RECIPIENT_A],
): ProviderEventRecord {
  const source = {
    kind: "provider_event_id" as const,
    value: `sns-event-${sequence}`,
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
    recipient_ids: recipientIds,
    provider_message_id: "ses-provider-message-1",
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

const adapters: Array<[string, () => Store]> = [
  ["memory", () => new MemoryStore()],
  [
    "dynamodb",
    () => {
      const fake = new TransactionalDynamoMemory();
      return new DynamoStore("table", undefined, fake.client);
    },
  ],
];

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) {
    return [values];
  }
  return values.flatMap((value, index) =>
    permutations(values.filter((_candidate, nested) => nested !== index)).map(
      (rest) => [value, ...rest],
    ),
  );
}

const convergenceCases: Array<{
  name: string;
  events: ProviderEventRecord["type"][];
  expected: RecipientRecord["status"];
}> = [
  {
    name: "delay then delivery",
    events: ["delayed", "delivered"],
    expected: "delivered",
  },
  {
    name: "delivery then older delay",
    events: ["delivered", "delayed"],
    expected: "delivered",
  },
  {
    name: "open then delivery",
    events: ["opened", "delivered"],
    expected: "opened",
  },
  {
    name: "click then open",
    events: ["clicked", "opened"],
    expected: "clicked",
  },
  {
    name: "bounce then delivery",
    events: ["bounced", "delivered"],
    expected: "bounced",
  },
  {
    name: "complaint then click",
    events: ["complained", "clicked"],
    expected: "complained",
  },
  {
    name: "failure then delivery",
    events: ["failed", "delivered"],
    expected: "failed",
  },
  ...permutations<ProviderEventRecord["type"]>([
    "delayed",
    "opened",
    "clicked",
  ]).map((events) => ({
    name: `generated delay/open/click race: ${events.join("-")}`,
    events,
    expected: "clicked" as const,
  })),
];

describe.each(adapters)("%s recipient-ledger contract", (_name, factory) => {
  it("commits locally suppressed recipients without dispatchable work", async () => {
    const store = factory();
    const value = delivery();
    value.email.status = "suppressed";
    value.email.last_event = "suppressed";
    value.message.status = "suppressed";
    value.recipients[0]!.status = "suppressed";
    value.outbox.dispatched_at = CREATED_AT;
    await store.commitDelivery(
      value,
      Math.floor(Date.parse(CREATED_AT) / 1_000),
    );

    await expect(store.getDeliveryLedger(MESSAGE_ID)).resolves.toMatchObject({
      email: { status: "suppressed" },
      message: { status: "suppressed" },
      recipients: [{ status: "suppressed" }],
    });
    await expect(
      store.leaseDueOutbox({
        owner: "ledger-contract",
        now: new Date(CREATED_AT),
        lease_seconds: 60,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it.each(convergenceCases)(
    "converges for $name without erasing immutable history",
    async ({ events, expected }) => {
      const store = await acceptedStore(factory);
      for (const [index, type] of events.entries()) {
        await store.appendProviderEvent(event(index + 1, type));
      }
      const ledger = await store.getDeliveryLedger(MESSAGE_ID);
      expect(ledger?.recipients[0]?.status).toBe(expected);
      expect(ledger?.events.map((item) => item.type)).toEqual(events);
    },
  );

  it("deduplicates immutable events and retains no private payload fields", async () => {
    const store = await acceptedStore(factory);
    const delivered = event(1, "delivered");
    await expect(
      store.appendProviderEvent(delivered),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      store.appendProviderEvent({
        ...delivered,
        received_at: "2026-07-26T02:00:59.000Z",
      }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      store.appendProviderEvent({
        ...delivered,
        type: "bounced",
      }),
    ).rejects.toThrow("different normalized event");
    const ledger = await store.getDeliveryLedger(MESSAGE_ID);
    expect(ledger?.events).toHaveLength(1);
    const serialized = JSON.stringify(ledger?.events);
    expect(serialized).not.toContain("first-recipient@example.net");
    expect(serialized).not.toContain("Private subject");
    expect(serialized).not.toContain("Private body");
    expect(serialized).not.toContain("smtp");
  });

  it("retains delivery and bounce for different recipients", async () => {
    const store = await acceptedStore(factory, 2);
    await store.appendProviderEvent(event(1, "delivered", [RECIPIENT_A]));
    await store.appendProviderEvent(event(2, "bounced", [RECIPIENT_B]));
    await store.appendProviderEvent(event(3, "delivered", [RECIPIENT_B]));
    const ledger = await store.getDeliveryLedger(MESSAGE_ID);
    expect(ledger?.recipients.map((recipient) => recipient.status)).toEqual([
      "delivered",
      "bounced",
    ]);
    expect(ledger?.message.status).toBe("partially_delivered");
    expect(ledger?.email.status).toBe("bounced");
    expect(ledger?.events).toHaveLength(3);
  });

  it("converges concurrent delivery and engagement mutations", async () => {
    const store = await acceptedStore(factory);
    await Promise.all([
      store.appendProviderEvent(event(1, "delivered")),
      store.appendProviderEvent(event(2, "opened")),
    ]);
    const ledger = await store.getDeliveryLedger(MESSAGE_ID);
    expect(ledger?.recipients[0]?.status).toBe("opened");
    expect(ledger?.events.map((item) => item.type)).toEqual([
      "delivered",
      "opened",
    ]);
  });

  it("keeps local suppression sticky against later provider events", async () => {
    const store = await acceptedStore(factory);
    await store.applyLocalDeliveryState(
      MESSAGE_ID,
      "suppressed",
      "2026-07-26T02:00:03.000Z",
    );
    await store.appendProviderEvent(event(1, "delivered"));
    const ledger = await store.getDeliveryLedger(MESSAGE_ID);
    expect(ledger?.recipients[0]?.status).toBe("suppressed");
    expect(ledger?.message.status).toBe("suppressed");
    expect(ledger?.events).toHaveLength(1);
  });

  it("keeps a local cancellation from being overwritten by later evidence", async () => {
    const store = await acceptedStore(factory);
    await store.applyLocalDeliveryState(
      MESSAGE_ID,
      "canceled",
      "2026-07-26T02:00:03.000Z",
    );
    await store.appendProviderEvent(event(1, "delivered"));
    const ledger = await store.getDeliveryLedger(MESSAGE_ID);
    expect(ledger?.recipients[0]?.status).toBe("canceled");
    expect(ledger?.message.status).toBe("canceled");
    expect(ledger?.events).toHaveLength(1);
  });
});

describe("DynamoDB optimistic recipient-ledger concurrency", () => {
  it("reloads and retries a real stale-snapshot transaction conflict", async () => {
    const fake = new TransactionalDynamoMemory();
    const store = await acceptedStore(
      () => new DynamoStore("table", undefined, fake.client),
    );
    fake.pauseNextLedgerQueries(2);

    await Promise.all([
      store.appendProviderEvent(event(1, "delivered")),
      store.appendProviderEvent(event(2, "opened")),
    ]);

    expect(fake.transactionCancellations).toBeGreaterThan(0);
    await expect(store.getDeliveryLedger(MESSAGE_ID)).resolves.toMatchObject({
      recipients: [{ status: "opened" }],
      events: [{ type: "delivered" }, { type: "opened" }],
    });
  });
});
