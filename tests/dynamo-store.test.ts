import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoStore } from "../src/adapters/dynamo-store.js";
import type {
  AttachmentUploadRecord,
  EmailRecord,
  ReceivedEmailRecord,
  TemplatePublicationRecord,
  TemplateRecord,
  WebhookDeliveryRecord,
  WebhookEndpoint,
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

const webhookDelivery: WebhookDeliveryRecord = {
  id: "msg_123",
  webhook_id: "wh_123",
  event_type: "email.sent",
  event: {
    type: "email.sent",
    created_at: "2030-01-01T00:00:00.000Z",
    data: {
      created_at: "2030-01-01T00:00:00.000Z",
      email_id: "email_123",
      from: "sender@example.com",
      to: ["recipient@example.net"],
      subject: "Subject",
    },
  },
  status: "pending",
  attempts: 0,
  created_at: "2030-01-01T00:00:00.000Z",
  updated_at: "2030-01-01T00:00:00.000Z",
  expires_at: "2030-01-08T00:00:00.000Z",
};

describe("DynamoStore", () => {
  it("translates a template ID cursor into a DynamoDB GSI start key", async () => {
    const template: TemplateRecord = {
      id: "tmpl_cursor",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:00:00.000Z",
      revision: 1,
      draft: {
        id: "tmplv_cursor",
        name: "Cursor",
        html: "<p>Cursor</p>",
        variables: [],
        created_at: "2030-01-01T00:00:00.000Z",
      },
    };
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return command instanceof GetCommand
          ? { Item: { entity: template } }
          : { Items: [] };
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await store.listTemplates(20, template.id);
    await store.listTemplates(10, template.id, "before");

    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect(commands[1]).toBeInstanceOf(QueryCommand);
    expect((commands[1] as QueryCommand).input).toMatchObject({
      IndexName: "GSI1",
      ExclusiveStartKey: {
        PK: "TEMPLATE#tmpl_cursor",
        SK: "TEMPLATE#tmpl_cursor",
        GSI1PK: "TEMPLATES",
        GSI1SK: "2030-01-01T00:00:00.000Z#tmpl_cursor",
      },
      ScanIndexForward: false,
      Limit: 20,
    });
    expect(commands[2]).toBeInstanceOf(GetCommand);
    expect(commands[3]).toBeInstanceOf(QueryCommand);
    expect((commands[3] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: "GSI1PK = :partition AND GSI1SK > :anchor",
      ExpressionAttributeValues: {
        ":partition": "TEMPLATES",
        ":anchor": "2030-01-01T00:00:00.000Z#tmpl_cursor",
      },
      ScanIndexForward: true,
      Limit: 10,
    });
    expect(
      (commands[3] as QueryCommand).input.ExclusiveStartKey,
    ).toBeUndefined();
  });

  it("changes template aliases and revisions in atomic transactions", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);
    const template: TemplateRecord = {
      id: "tmpl_123",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:00:00.000Z",
      revision: 1,
      draft: {
        id: "tmplv_123",
        name: "Welcome",
        alias: "welcome",
        html: "<p>Welcome</p>",
        variables: [],
        created_at: "2030-01-01T00:00:00.000Z",
      },
    };

    await store.createTemplate(template);
    const updated: TemplateRecord = {
      ...template,
      revision: 2,
      updated_at: "2030-01-01T00:01:00.000Z",
      draft: {
        ...template.draft,
        id: "tmplv_456",
        alias: "welcome-v2",
        created_at: "2030-01-01T00:01:00.000Z",
      },
    };
    await store.replaceTemplate(updated, "welcome", 1);
    await store.deleteTemplate(updated, 2);

    expect(commands).toHaveLength(4);
    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    const createItems = (commands[0] as TransactWriteCommand).input
      .TransactItems;
    expect(createItems).toHaveLength(2);
    expect(createItems?.[0]?.Put?.Item).toMatchObject({
      PK: "TEMPLATE#tmpl_123",
      GSI1PK: "TEMPLATES",
      entity: template,
    });
    expect(createItems?.[1]?.Put?.Item).toEqual({
      PK: "TEMPLATE_ALIAS#welcome",
      SK: "TEMPLATE_ALIAS#welcome",
      template_id: "tmpl_123",
    });

    expect(commands[1]).toBeInstanceOf(TransactWriteCommand);
    const replaceItems = (commands[1] as TransactWriteCommand).input
      .TransactItems;
    expect(replaceItems).toHaveLength(3);
    expect(replaceItems?.[0]?.Put).toMatchObject({
      ConditionExpression:
        "attribute_exists(PK) AND entity.#revision = :expected_revision",
      ExpressionAttributeValues: { ":expected_revision": 1 },
    });
    expect(replaceItems?.[1]?.Delete?.Key).toEqual({
      PK: "TEMPLATE_ALIAS#welcome",
      SK: "TEMPLATE_ALIAS#welcome",
    });
    expect(replaceItems?.[2]?.Put?.Item).toMatchObject({
      PK: "TEMPLATE_ALIAS#welcome-v2",
      template_id: "tmpl_123",
    });

    expect(commands[2]).toBeInstanceOf(QueryCommand);
    expect(commands[3]).toBeInstanceOf(TransactWriteCommand);
    const deleteItems = (commands[3] as TransactWriteCommand).input
      .TransactItems;
    expect(deleteItems).toHaveLength(2);
    expect(deleteItems?.[0]?.Delete).toMatchObject({
      Key: {
        PK: "TEMPLATE#tmpl_123",
        SK: "TEMPLATE#tmpl_123",
      },
      ExpressionAttributeValues: { ":expected_revision": 2 },
    });
  });

  it("publishes a template and immutable history record in one transaction", async () => {
    const commands: unknown[] = [];
    const template: TemplateRecord = {
      id: "tmpl_123",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:01:00.000Z",
      revision: 2,
      draft: {
        id: "tmplv_123",
        name: "Welcome",
        alias: "welcome",
        html: "<p>Welcome</p>",
        variables: [],
        created_at: "2030-01-01T00:00:00.000Z",
      },
      published: {
        id: "tmplv_123",
        name: "Welcome",
        alias: "welcome",
        html: "<p>Welcome</p>",
        variables: [],
        created_at: "2030-01-01T00:00:00.000Z",
      },
      published_at: "2030-01-01T00:01:00.000Z",
    };
    const publication: TemplatePublicationRecord = {
      id: "tmplv_123",
      template_id: template.id,
      version: structuredClone(template.draft),
      published_at: "2030-01-01T00:01:00.000Z",
      expires_at: "2030-04-01T00:01:00.000Z",
      actor: { id: "key_123", name: "Release automation" },
      source: "cli",
    };
    const storedPublication = {
      PK: "TEMPLATE_VERSION#tmpl_123",
      SK: "TEMPLATE_VERSION#tmplv_123",
      GSI1PK: "TEMPLATE_VERSIONS#tmpl_123",
      GSI1SK: "2030-01-01T00:01:00.000Z#tmplv_123",
      entity: publication,
      ttl: Math.floor(Date.parse(publication.expires_at) / 1_000),
    };
    const client = {
      async send(command: unknown) {
        commands.push(command);
        if (command instanceof GetCommand) {
          return { Item: storedPublication };
        }
        if (
          command instanceof QueryCommand &&
          command.input.IndexName === "GSI1"
        ) {
          return { Items: [storedPublication] };
        }
        return { Items: [] };
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    await expect(
      store.publishTemplate(template, publication, undefined, 1, 50),
    ).resolves.toBe(true);
    await expect(
      store.getTemplateVersion(template.id, publication.id),
    ).resolves.toEqual(publication);
    await expect(
      store.listTemplateVersions(
        template.id,
        20,
        undefined,
        Math.floor(Date.parse("2030-01-02T00:00:00.000Z") / 1_000),
      ),
    ).resolves.toMatchObject({
      data: [publication],
      has_more: false,
    });
    await store.listTemplateVersions(
      template.id,
      20,
      publication,
      Math.floor(Date.parse("2030-01-02T00:00:00.000Z") / 1_000),
    );

    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[1]).toBeInstanceOf(TransactWriteCommand);
    const publishItems = (commands[1] as TransactWriteCommand).input
      .TransactItems;
    expect(publishItems?.[0]?.Put).toMatchObject({
      ConditionExpression:
        "attribute_exists(PK) AND entity.#revision = :expected_revision",
      ExpressionAttributeValues: { ":expected_revision": 1 },
    });
    expect(publishItems?.[1]?.Put?.Item).toEqual(storedPublication);
    expect(publishItems?.[1]?.Put?.ConditionExpression).toBe(
      "attribute_not_exists(PK)",
    );
    expect(publishItems?.[2]?.Put?.Item).toMatchObject({
      PK: "TEMPLATE_PUBLISHED_ALIAS#welcome",
      template_id: template.id,
    });
    expect(commands[2]).toBeInstanceOf(GetCommand);
    expect((commands[2] as GetCommand).input.Key).toEqual({
      PK: "TEMPLATE_VERSION#tmpl_123",
      SK: "TEMPLATE_VERSION#tmplv_123",
    });
    expect(commands[3]).toBeInstanceOf(QueryCommand);
    expect((commands[3] as QueryCommand).input).toMatchObject({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :partition",
      ExpressionAttributeValues: {
        ":partition": "TEMPLATE_VERSIONS#tmpl_123",
      },
      ScanIndexForward: false,
    });
    expect(commands[4]).toBeInstanceOf(QueryCommand);
    expect((commands[4] as QueryCommand).input.ExclusiveStartKey).toEqual({
      PK: storedPublication.PK,
      SK: storedPublication.SK,
      GSI1PK: storedPublication.GSI1PK,
      GSI1SK: storedPublication.GSI1SK,
    });
  });

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

  it("updates webhook fields atomically without replacing its secret", async () => {
    const webhook: WebhookEndpoint = {
      id: "wh_123",
      endpoint: "https://example.com/hooks",
      events: ["email.sent"],
      signing_secret: "whsec_existing",
      status: "enabled",
      created_at: "2030-01-01T00:00:00.000Z",
    };
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        return {
          Attributes: {
            entity: {
              ...webhook,
              events: ["email.bounced"],
              status: "disabled",
            },
          },
        };
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    const updated = await store.updateWebhook(webhook.id, {
      events: ["email.bounced"],
      status: "disabled",
    });

    expect(updated).toMatchObject({
      signing_secret: "whsec_existing",
      events: ["email.bounced"],
      status: "disabled",
    });
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    if (!(command instanceof UpdateCommand)) {
      throw new Error("Expected UpdateCommand.");
    }
    expect(command.input).toMatchObject({
      Key: {
        PK: "WEBHOOK#wh_123",
        SK: "WEBHOOK#wh_123",
      },
      ConditionExpression: "attribute_exists(PK)",
      ReturnValues: "ALL_NEW",
    });
    expect(command.input.UpdateExpression).toContain("SET entity.");
    expect(command.input.UpdateExpression).not.toContain("signing_secret");
  });

  it("stores, updates, and paginates expiring webhook deliveries", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        if (command instanceof UpdateCommand) {
          return {
            Attributes: {
              entity: {
                ...webhookDelivery,
                status: "succeeded",
                attempts: 1,
                response_status: 204,
              },
            },
          };
        }
        if (command instanceof QueryCommand) {
          return {
            Items: [{ entity: webhookDelivery }],
            LastEvaluatedKey: {
              PK: "WEBHOOK_DELIVERY#msg_123",
              SK: "WEBHOOK_DELIVERY#msg_123",
            },
          };
        }
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new DynamoStore("table", undefined, client);

    expect(await store.createWebhookDelivery(webhookDelivery)).toBe(true);
    const updated = await store.updateWebhookDelivery(webhookDelivery.id, {
      status: "succeeded",
      attempts: 1,
      response_status: 204,
      last_error: undefined,
      updated_at: "2030-01-01T00:00:01.000Z",
    });
    const page = await store.listWebhookDeliveries(
      webhookDelivery.webhook_id,
      20,
    );

    expect(updated).toMatchObject({
      status: "succeeded",
      attempts: 1,
      response_status: 204,
    });
    expect(page.data).toEqual([webhookDelivery]);
    expect(page.has_more).toBe(true);
    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect((commands[0] as PutCommand).input.Item).toMatchObject({
      PK: "WEBHOOK_DELIVERY#msg_123",
      SK: "WEBHOOK_DELIVERY#msg_123",
      GSI1PK: "WEBHOOK_DELIVERIES#wh_123",
      entity: webhookDelivery,
      ttl: Math.floor(Date.parse(webhookDelivery.expires_at) / 1_000),
    });
    expect(commands[1]).toBeInstanceOf(UpdateCommand);
    expect((commands[1] as UpdateCommand).input).toMatchObject({
      ConditionExpression: "attribute_exists(PK) AND ttl > :now",
      ReturnValues: "ALL_NEW",
    });
    expect((commands[1] as UpdateCommand).input.UpdateExpression).toContain(
      "REMOVE entity.",
    );
    expect(commands[2]).toBeInstanceOf(QueryCommand);
    expect((commands[2] as QueryCommand).input).toMatchObject({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :partition",
      FilterExpression: "ttl > :now",
      ScanIndexForward: false,
      Limit: 20,
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
    await store.releaseReceivedEmailClaim("recv_123", 1_900_000_300);

    expect(claimed).toBe(true);
    expect(created).toBe(true);
    expect(commands[0]).toBeInstanceOf(UpdateCommand);
    expect((commands[0] as UpdateCommand).input).toMatchObject({
      ConditionExpression: "attribute_not_exists(PK) OR lease_until < :now",
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

    expect(updated?.webhook_queued_at).toBe("2030-03-17T17:47:00.000Z");
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
