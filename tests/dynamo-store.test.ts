import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoStore } from "../src/adapters/dynamo-store.js";
import type {
  AttachmentUploadRecord,
  EmailRecord,
  ReceivedEmailRecord,
} from "../src/core/types.js";

const email: EmailRecord = {
  id: "email_123",
  from: "sender@example.com",
  to: ["recipient@example.net"],
  subject: "Subject",
  text: "Body",
  status: "sent",
  last_event: "sent",
  created_at: "2026-07-26T00:00:00.000Z",
  updated_at: "2026-07-26T00:00:01.000Z",
  request_hash: "hash",
  attempts: 1,
};

describe("DynamoStore", () => {
  it("stores upload metadata with a DynamoDB TTL", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);
    const upload: AttachmentUploadRecord = {
      id: "att_1234567890abcdef1234567890abcdef",
      filename: "report.txt",
      content_type: "text/plain",
      size_bytes: 42,
      checksum_sha256: "0".repeat(64),
      object_key: "attachments/att_123/content",
      upload_token_hash: "hash",
      created_at: "2030-01-01T00:00:00.000Z",
      upload_expires_at: "2030-01-01T00:15:00.000Z",
      expires_at: "2030-01-02T00:00:00.000Z",
    };

    await store.putAttachmentUpload(upload);

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect((commands[0] as PutCommand).input.Item).toMatchObject({
      PK: `ATTACHMENT#${upload.id}`,
      SK: `ATTACHMENT#${upload.id}`,
      entity: upload,
      ttl: 1_893_542_400,
    });
  });

  it("uses a conditional partial update for state transitions", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return { Attributes: { entity: email } };
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await store.updateEmail(
      email.id,
      {
        status: "sent",
        provider_id: "ses-id",
        send_lease_until: undefined,
      },
      ["sending"],
    );

    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    if (!(command instanceof UpdateCommand)) {
      throw new Error("Expected UpdateCommand.");
    }
    expect(command.input.ConditionExpression).toContain(
      "entity.#currentStatus IN",
    );
    expect(command.input.UpdateExpression).toContain("SET entity.");
    expect(command.input.UpdateExpression).toContain("REMOVE entity.");
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":fromStatus0": "sending",
    });
  });

  it("claims inbound processing with a lease and persists retention TTL", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);
    const claimed = await store.claimReceivedEmail(
      "recv_123",
      1_900_000_000,
      1_900_000_300,
      1_900_604_800,
    );
    const received: ReceivedEmailRecord = {
      id: "recv_123",
      provider_message_id: "provider-123",
      message_id: "<message@example.com>",
      from: "sender@example.com",
      to: ["recipient@example.net"],
      received_for: ["recipient@example.net"],
      bcc: [],
      cc: [],
      reply_to: [],
      subject: "Inbound",
      created_at: "2030-03-17T17:46:40.000Z",
      raw_object_key: "inbound/raw/provider-123",
      content_object_key: "inbound/content/recv_123.json",
      attachments: [],
      content_truncated: false,
      expires_at: "2030-03-24T17:46:40.000Z",
    };
    const created = await store.createReceivedEmail(received);
    await store.releaseReceivedEmailClaim(
      "recv_123",
      1_900_000_300,
    );

    expect(claimed).toBe(true);
    expect(created).toBe(true);
    expect(commands[0]).toBeInstanceOf(UpdateCommand);
    expect((commands[0] as UpdateCommand).input).toMatchObject({
      ConditionExpression:
        "attribute_not_exists(PK) OR lease_until < :now",
      ExpressionAttributeValues: {
        ":lease": 1_900_000_300,
        ":now": 1_900_000_000,
        ":ttl": 1_900_604_800,
      },
    });
    expect(commands[1]).toBeInstanceOf(PutCommand);
    expect((commands[1] as PutCommand).input.Item).toMatchObject({
      PK: "RECEIVED#recv_123",
      GSI1PK: "RECEIVED_EMAILS",
      entity: received,
      ttl: 1_900_604_800,
    });
    expect(commands[2]).toBeInstanceOf(DeleteCommand);
    expect((commands[2] as DeleteCommand).input).toMatchObject({
      Key: {
        PK: "RECEIVED_CLAIM#recv_123",
        SK: "RECEIVED_CLAIM#recv_123",
      },
      ConditionExpression: "lease_until = :lease",
      ExpressionAttributeValues: {
        ":lease": 1_900_000_300,
      },
    });
  });

  it("preserves the received-email TTL when metadata is updated", async () => {
    const received: ReceivedEmailRecord = {
      id: "recv_456",
      provider_message_id: "provider-456",
      message_id: "<message-456@example.com>",
      from: "sender@example.com",
      to: ["recipient@example.net"],
      received_for: ["recipient@example.net"],
      bcc: [],
      cc: [],
      reply_to: [],
      subject: "Inbound update",
      created_at: "2030-03-17T17:46:40.000Z",
      raw_object_key: "inbound/raw/provider-456",
      content_object_key: "inbound/content/recv_456.json",
      attachments: [],
      content_truncated: false,
      expires_at: "2030-03-24T17:46:40.000Z",
    };
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        if (command instanceof GetCommand) {
          return { Item: { entity: received } };
        }
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    const updated = await store.updateReceivedEmail(received.id, {
      webhook_queued_at: "2030-03-17T17:47:00.000Z",
    });

    expect(updated?.webhook_queued_at).toBe(
      "2030-03-17T17:47:00.000Z",
    );
    expect(commands[1]).toBeInstanceOf(PutCommand);
    expect((commands[1] as PutCommand).input.Item).toMatchObject({
      PK: "RECEIVED#recv_456",
      entity: {
        ...received,
        webhook_queued_at: "2030-03-17T17:47:00.000Z",
      },
      ttl: 1_900_604_800,
    });
  });
});
