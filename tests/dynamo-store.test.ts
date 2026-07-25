import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoStore } from "../src/adapters/dynamo-store.js";
import type {
  AttachmentUploadRecord,
  EmailRecord,
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
});
