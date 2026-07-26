import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoStore } from "../src/adapters/dynamo-store.js";
import { createOutboxIdentity } from "../src/core/delivery-model.js";
import type { DeliveryCommit } from "../src/ports/delivery-outbox-store.js";

const NOW = new Date("2026-07-26T02:00:00.000Z");
const MESSAGE_ID = "email_00000000000000000000000000000001";
const RECIPIENT_ID = "rcpt_00000000000000000000000000000001";
const OUTBOX_ID = createOutboxIdentity({
  message_id: MESSAGE_ID,
  job_type: "dispatch-message",
  generation: 0,
});

function delivery(): DeliveryCommit {
  const timestamp = NOW.toISOString();
  return {
    email: {
      id: MESSAGE_ID,
      from: "sender@example.com",
      to: ["recipient@example.net"],
      subject: "Private subject",
      text: "Private body",
      status: "queued",
      last_event: "queued",
      created_at: timestamp,
      updated_at: timestamp,
      request_hash: "0".repeat(64),
      attempts: 0,
    },
    message: {
      schema_version: "1.0.0",
      record_type: "message",
      id: MESSAGE_ID,
      provider: {
        name: "aws-ses",
        adapter_version: "0.1.0",
        capability_version: "1.0.0",
      },
      intent_digest: "0".repeat(64),
      recipient_ids: [RECIPIENT_ID],
      status: "queued",
      created_at: timestamp,
      updated_at: timestamp,
    },
    recipients: [
      {
        schema_version: "1.0.0",
        record_type: "recipient",
        id: RECIPIENT_ID,
        message_id: MESSAGE_ID,
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
      id: OUTBOX_ID,
      message_id: MESSAGE_ID,
      job_type: "dispatch-message",
      generation: 0,
      due_at: timestamp,
      attempts: 0,
      created_at: timestamp,
      updated_at: timestamp,
    },
    idempotency: {
      key_hash: "1".repeat(64),
      request_hash: "0".repeat(64),
      expires_at: Math.floor(NOW.getTime() / 1_000) + 86_400,
    },
  };
}

function storedOutbox(
  entity = delivery().outbox,
  partition = "OUTBOX_DUE",
  sort = `${entity.due_at}#${entity.id}`,
) {
  return {
    PK: `OUTBOX#${entity.id}`,
    SK: `OUTBOX#${entity.id}`,
    GSI1PK: partition,
    GSI1SK: sort,
    entity,
  };
}

describe("DynamoStore transactional outbox", () => {
  it("atomically commits email, provider-neutral records, outbox, idempotency, and metrics", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);
    const value = delivery();

    await expect(
      store.commitDelivery(
        value,
        Math.floor(NOW.getTime() / 1_000),
      ),
    ).resolves.toMatchObject({
      email: { id: MESSAGE_ID },
      message: { id: MESSAGE_ID },
      outbox: { id: OUTBOX_ID },
      replayed: false,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    const items = (commands[0] as TransactWriteCommand).input
      .TransactItems;
    expect(items).toHaveLength(6);
    expect(items?.[0]?.Put?.Item).toMatchObject({
      PK: `EMAIL#${MESSAGE_ID}`,
      GSI1PK: "EMAILS",
      entity: value.email,
    });
    expect(items?.[1]?.Put?.Item).toEqual({
      PK: `EMAIL#${MESSAGE_ID}`,
      SK: `DELIVERY_MESSAGE#${MESSAGE_ID}`,
      entity: value.message,
    });
    expect(items?.[2]?.Put?.Item).toEqual({
      PK: `EMAIL#${MESSAGE_ID}`,
      SK: `RECIPIENT#${RECIPIENT_ID}`,
      entity: value.recipients[0],
    });
    expect(items?.[3]?.Put?.Item).toEqual(
      storedOutbox(value.outbox),
    );
    expect(items?.[4]?.Put?.Item).toMatchObject({
      PK: `IDEMPOTENCY#${value.idempotency?.key_hash}`,
      email_id: MESSAGE_ID,
      request_hash: value.email.request_hash,
    });
    expect(items?.[5]?.Update).toMatchObject({
      Key: {
        PK: "OUTBOX_METRICS",
        SK: "OUTBOX_METRICS",
      },
      UpdateExpression:
        "SET updated_at = :updated ADD undispatched :one",
      ExpressionAttributeValues: {
        ":updated": NOW.toISOString(),
        ":one": 1,
      },
    });
  });

  it("keeps the public 50-recipient maximum below DynamoDB's transaction limit", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);
    const value = delivery();
    const recipients = Array.from({ length: 50 }, (_, index) => ({
      ...value.recipients[0]!,
      id: `rcpt_${String(index).padStart(32, "0")}`,
      ordinal: index,
      address: `recipient-${index}@example.net`,
    }));
    value.email.to = recipients.map((recipient) => recipient.address);
    value.recipients = recipients;
    value.message.recipient_ids = recipients.map(
      (recipient) => recipient.id,
    );

    await store.commitDelivery(
      value,
      Math.floor(NOW.getTime() / 1_000),
    );

    const items = (commands[0] as TransactWriteCommand).input
      .TransactItems;
    expect(items).toHaveLength(55);
    expect(items?.length).toBeLessThanOrEqual(100);
  });

  it("leases due and expired items through the sparse GSI and a conditional base-table update", async () => {
    const commands: unknown[] = [];
    const due = delivery().outbox;
    const leased = {
      ...due,
      attempts: 1,
      lease_owner: "dispatcher-one",
      lease_expires_at: "2026-07-26T02:01:00.000Z",
      updated_at: NOW.toISOString(),
    };
    const client = {
      async send(command: unknown) {
        commands.push(command);
        if (command instanceof QueryCommand) {
          return command.input.ExpressionAttributeValues?.[
            ":partition"
          ] === "OUTBOX_DUE"
            ? { Items: [storedOutbox(due)] }
            : { Items: [] };
        }
        if (command instanceof UpdateCommand) {
          return {
            Attributes: storedOutbox(
              leased,
              "OUTBOX_LEASED",
              `${leased.lease_expires_at}#${leased.id}`,
            ),
          };
        }
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await expect(
      store.leaseDueOutbox({
        owner: "dispatcher-one",
        now: NOW,
        lease_seconds: 60,
        limit: 10,
      }),
    ).resolves.toEqual([leased]);

    const queries = commands.filter(
      (command): command is QueryCommand =>
        command instanceof QueryCommand,
    );
    expect(queries).toHaveLength(2);
    expect(queries[0]?.input).toMatchObject({
      IndexName: "GSI1",
      KeyConditionExpression:
        "GSI1PK = :partition AND GSI1SK <= :upper",
      ExpressionAttributeValues: {
        ":partition": "OUTBOX_DUE",
        ":upper": `${NOW.toISOString()}#\uffff`,
      },
      Limit: 10,
    });
    const update = commands.find(
      (command): command is UpdateCommand =>
        command instanceof UpdateCommand,
    );
    expect(update?.input).toMatchObject({
      Key: {
        PK: `OUTBOX#${OUTBOX_ID}`,
        SK: `OUTBOX#${OUTBOX_ID}`,
      },
      ConditionExpression:
        "attribute_exists(PK) AND attribute_not_exists(entity.dispatched_at) AND entity.due_at <= :now AND (attribute_not_exists(entity.lease_expires_at) OR entity.lease_expires_at <= :now)",
      ReturnValues: "ALL_NEW",
    });
  });

  it("acknowledges a lease and decrements the durable backlog in one transaction", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await expect(
      store.acknowledgeOutbox(OUTBOX_ID, "dispatcher-one", NOW),
    ).resolves.toBe(true);

    const items = (commands[0] as TransactWriteCommand).input
      .TransactItems;
    expect(items?.[0]?.Update).toMatchObject({
      Key: {
        PK: `OUTBOX#${OUTBOX_ID}`,
        SK: `OUTBOX#${OUTBOX_ID}`,
      },
      ConditionExpression:
        "entity.lease_owner = :owner AND attribute_not_exists(entity.dispatched_at)",
    });
    expect(items?.[0]?.Update?.UpdateExpression).toContain(
      "REMOVE entity.lease_owner, entity.lease_expires_at, GSI1PK, GSI1SK",
    );
    expect(items?.[1]?.Update).toMatchObject({
      Key: {
        PK: "OUTBOX_METRICS",
        SK: "OUTBOX_METRICS",
      },
      ExpressionAttributeValues: {
        ":now": NOW.toISOString(),
        ":minus_one": -1,
      },
    });
  });

  it("atomically moves a scheduled email, delivery message, and pending outbox", async () => {
    const commands: unknown[] = [];
    const value = delivery();
    const scheduledAt = "2026-07-26T02:30:00.000Z";
    const client = {
      async send(command: unknown) {
        commands.push(command);
        if (command instanceof GetCommand) {
          return {
            Item: {
              entity: {
                ...value.email,
                status: "scheduled",
                scheduled_at: scheduledAt,
              },
            },
          };
        }
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await expect(
      store.rescheduleEmailAndOutbox(MESSAGE_ID, scheduledAt, NOW),
    ).resolves.toMatchObject({
      id: MESSAGE_ID,
      status: "scheduled",
      scheduled_at: scheduledAt,
    });

    const items = (commands[0] as TransactWriteCommand).input
      .TransactItems;
    expect(items).toHaveLength(3);
    expect(items?.[0]?.Update?.Key).toEqual({
      PK: `EMAIL#${MESSAGE_ID}`,
      SK: `EMAIL#${MESSAGE_ID}`,
    });
    expect(items?.[1]?.Update?.Key).toEqual({
      PK: `EMAIL#${MESSAGE_ID}`,
      SK: `DELIVERY_MESSAGE#${MESSAGE_ID}`,
    });
    expect(items?.[2]?.Update).toMatchObject({
      Key: {
        PK: `OUTBOX#${OUTBOX_ID}`,
        SK: `OUTBOX#${OUTBOX_ID}`,
      },
      ConditionExpression:
        "attribute_not_exists(entity.dispatched_at) AND attribute_not_exists(entity.lease_owner)",
      ExpressionAttributeValues: {
        ":scheduled": scheduledAt,
        ":updated": NOW.toISOString(),
        ":due_partition": "OUTBOX_DUE",
        ":due_sort": `${scheduledAt}#${OUTBOX_ID}`,
      },
    });
  });

  it("releases a failed lease for retry without persisting private error text", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await expect(
      store.recordOutboxFailure(
        OUTBOX_ID,
        "dispatcher-one",
        "provider_unavailable",
        NOW,
      ),
    ).resolves.toBe(true);

    const items = (commands[0] as TransactWriteCommand).input
      .TransactItems;
    expect(items?.[0]?.Update).toMatchObject({
      ExpressionAttributeValues: {
        ":category": "provider_unavailable",
        ":owner": "dispatcher-one",
        ":now": NOW.toISOString(),
        ":due_partition": "OUTBOX_DUE",
        ":due_sort": `${NOW.toISOString()}#${OUTBOX_ID}`,
      },
    });
    expect(JSON.stringify(commands)).not.toContain("recipient@example.net");
    expect(items?.[1]?.Update?.UpdateExpression).toContain(
      "ADD publish_failures_total :one",
    );
  });

  it("reports due, active, expired, durable, and truncation state without message data", async () => {
    const due = {
      ...delivery().outbox,
      due_at: "2026-07-26T01:55:00.000Z",
    };
    const activeLease = {
      ...delivery().outbox,
      id: createOutboxIdentity({
        message_id: MESSAGE_ID,
        job_type: "reconcile-message",
        generation: 1,
      }),
      job_type: "reconcile-message" as const,
      generation: 1,
      due_at: "2026-07-26T01:58:00.000Z",
      lease_owner: "dispatcher-active",
      lease_expires_at: "2026-07-26T02:01:00.000Z",
    };
    const expiredLease = {
      ...delivery().outbox,
      id: createOutboxIdentity({
        message_id: MESSAGE_ID,
        job_type: "reconcile-message",
        generation: 2,
      }),
      job_type: "reconcile-message" as const,
      generation: 2,
      due_at: "2026-07-26T01:50:00.000Z",
      lease_owner: "dispatcher-expired",
      lease_expires_at: "2026-07-26T01:59:00.000Z",
    };
    const client = {
      async send(command: unknown) {
        if (command instanceof QueryCommand) {
          return command.input.ExpressionAttributeValues?.[
            ":partition"
          ] === "OUTBOX_DUE"
            ? {
                Items: [storedOutbox(due)],
                LastEvaluatedKey: { PK: "more" },
              }
            : {
                Items: [
                  storedOutbox(
                    activeLease,
                    "OUTBOX_LEASED",
                    `${activeLease.lease_expires_at}#${activeLease.id}`,
                  ),
                  storedOutbox(
                    expiredLease,
                    "OUTBOX_LEASED",
                    `${expiredLease.lease_expires_at}#${expiredLease.id}`,
                  ),
                ],
              };
        }
        if (command instanceof GetCommand) {
          return {
            Item: {
              undispatched: 19,
              publish_failures_total: 3,
            },
          };
        }
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await expect(store.getOutboxMetrics(NOW)).resolves.toEqual({
      due: 2,
      leased: 1,
      stuck_leases: 1,
      undispatched: 19,
      oldest_due_age_seconds: 600,
      publish_failures_total: 3,
      truncated: true,
    });
  });
});
