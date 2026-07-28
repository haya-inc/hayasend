import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import applicationStoreMigration from "../../migrations/postgres/0002_application_store.sql?raw";
import deliveryMigration from "../../migrations/postgres/0001_delivery.sql?raw";
import jobsMigration from "../../migrations/postgres/0003_jobs.sql?raw";
import {
  migratePostgres,
  POSTGRES_MIGRATIONS,
} from "../../src/adapters/postgres/postgres-migrations.js";
import { PostgresStore } from "../../src/adapters/postgres/postgres-store.js";
import type {
  ApiKeyRecord,
  AttachmentUploadRecord,
  DomainRecord,
  EmailRecord,
  ReceivedEmailRecord,
  SuppressionRecord,
  TemplatePublicationRecord,
  TemplateRecord,
  WebhookDeliveryRecord,
  WebhookEndpoint,
} from "../../src/core/types.js";
import { substrateDelivery } from "../helpers/delivery-substrate-contract.js";

const databaseUrl = process.env.HAYASEND_POSTGRES_TEST_URL;

function email(
  id: string,
  createdAt = "2030-01-01T00:00:00.000Z",
): EmailRecord {
  return {
    id,
    from: "sender@example.com",
    to: ["recipient@example.net"],
    subject: id,
    text: "Body",
    status: "queued",
    last_event: "queued",
    created_at: createdAt,
    updated_at: createdAt,
    request_hash: `request-${id}`,
    attempts: 0,
  };
}

function template(
  id: string,
  alias: string,
  createdAt = "2030-01-01T00:00:00.000Z",
): TemplateRecord {
  return {
    id,
    revision: 1,
    created_at: createdAt,
    updated_at: createdAt,
    draft: {
      id: `${id}_v1`,
      name: alias,
      alias,
      html: `<p>${alias}</p>`,
      variables: [],
      created_at: createdAt,
    },
  };
}

function received(
  id: string,
  expiresAt: string,
): ReceivedEmailRecord {
  return {
    id,
    provider_message_id: `provider-${id}`,
    message_id: `<${id}@example.com>`,
    from: "sender@example.com",
    to: ["recipient@example.net"],
    received_for: ["recipient@example.net"],
    bcc: [],
    cc: [],
    reply_to: [],
    subject: id,
    created_at: "2030-01-01T00:00:00.000Z",
    raw_object_key: `inbound/raw/${id}`,
    content_object_key: `inbound/content/${id}.json`,
    attachments: [],
    content_truncated: false,
    expires_at: expiresAt,
  };
}

function webhookDelivery(
  id: string,
  webhookId: string,
): WebhookDeliveryRecord {
  return {
    id,
    webhook_id: webhookId,
    event_type: "email.sent",
    event: {
      type: "email.sent",
      created_at: "2099-01-01T00:00:00.000Z",
      data: {
        created_at: "2099-01-01T00:00:00.000Z",
        email_id: "email_123",
        from: "sender@example.com",
        to: ["recipient@example.net"],
        subject: "Subject",
      },
    },
    status: "pending",
    attempts: 0,
    created_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
    expires_at: "2099-01-08T00:00:00.000Z",
  };
}

describe("packaged PostgreSQL migrations", () => {
  it("keeps packaged SQL and executable migrations identical", () => {
    expect(POSTGRES_MIGRATIONS.map((migration) => migration.sql.trim())).toEqual(
      [
        deliveryMigration.trim(),
        applicationStoreMigration.trim(),
        jobsMigration.trim(),
      ],
    );
  });
});

if (!databaseUrl) {
  describe.skip("PostgreSQL application store", () => {
    it("requires HAYASEND_POSTGRES_TEST_URL", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const store = new PostgresStore(pool);

  beforeAll(async () => {
    await migratePostgres(pool);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE
         received_email_claims,
         template_aliases,
         app_entities,
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

  describe("forward-only migrations", () => {
    it("serializes concurrent runners and records immutable checksums", async () => {
      await Promise.all([migratePostgres(pool), migratePostgres(pool)]);
      const result = await pool.query<{
        version: string;
        checksum_sha256: string;
      }>(
        "SELECT version, checksum_sha256 FROM hayasend_schema_migrations ORDER BY version",
      );
      expect(result.rows).toEqual([
        {
          version: "0001_delivery",
          checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          version: "0002_application_store",
          checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          version: "0003_jobs",
          checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
    });
  });

  describe("email state", () => {
    it("replays idempotently and applies send leases atomically", async () => {
      const record = email("email_postgres_store");
      const idempotency = {
        key_hash: "a".repeat(64),
        request_hash: record.request_hash,
        expires_at: Math.floor(Date.parse("2099-01-01T00:00:00.000Z") / 1_000),
      };
      await expect(store.createEmail(record, idempotency)).resolves.toMatchObject(
        { replayed: false, record: { id: record.id } },
      );
      await expect(store.createEmail(record, idempotency)).resolves.toMatchObject(
        { replayed: true, record: { id: record.id } },
      );
      await expect(
        store.createEmail(record, {
          ...idempotency,
          request_hash: "different",
        }),
      ).rejects.toThrow("different request");

      const now = new Date("2030-01-01T00:00:01.000Z");
      const [left, right] = await Promise.all([
        store.claimEmailForSend(record.id, 1, now),
        store.claimEmailForSend(record.id, 1, now),
      ]);
      expect([left, right].filter(Boolean)).toHaveLength(1);
      await expect(store.getEmail(record.id)).resolves.toMatchObject({
        status: "sending",
        attempts: 1,
      });
    });

    it("uses stable ID cursors and updates an undispatched schedule atomically", async () => {
      await store.createEmail(
        email("email_a", "2030-01-01T00:00:00.000Z"),
      );
      await store.createEmail(
        email("email_c", "2030-01-01T00:00:00.000Z"),
      );
      await store.createEmail(
        email("email_b", "2030-01-01T00:00:00.000Z"),
      );
      const first = await store.listEmails(2);
      expect(first).toMatchObject({
        data: [{ id: "email_c" }, { id: "email_b" }],
        has_more: true,
        next_cursor: "email_b",
      });
      await expect(store.listEmails(2, first.next_cursor)).resolves.toMatchObject(
        { data: [{ id: "email_a" }], has_more: false },
      );
      await expect(
        store.listEmails(10, "email_missing"),
      ).rejects.toMatchObject({ name: "validation_error" });

      const delivery = substrateDelivery(
        "postgresreschedule00000000000001",
      );
      await store.commitDelivery(
        delivery,
        Math.floor(Date.parse(delivery.email.created_at) / 1_000),
      );
      const scheduledAt = "2026-07-27T15:00:00.000Z";
      await expect(
        store.rescheduleEmailAndOutbox(
          delivery.email.id,
          scheduledAt,
          new Date("2026-07-27T14:05:00.000Z"),
        ),
      ).resolves.toMatchObject({
        id: delivery.email.id,
        status: "scheduled",
        scheduled_at: scheduledAt,
      });
      await expect(store.getDelivery(delivery.email.id)).resolves.toMatchObject({
        message: { status: "scheduled", scheduled_at: scheduledAt },
        outbox: { due_at: scheduledAt },
      });
    });
  });

  describe("templates", () => {
    it("keeps aliases, revisions, publication history, and deletion atomic", async () => {
      const first = template("tmpl_postgres", "welcome");
      await store.createTemplate(first);
      await expect(store.getTemplate("welcome")).resolves.toEqual(first);

      const revised: TemplateRecord = {
        ...first,
        revision: 2,
        updated_at: "2030-01-01T00:01:00.000Z",
        draft: {
          ...first.draft,
          id: "tmpl_postgres_v2",
          alias: "greeting",
          created_at: "2030-01-01T00:01:00.000Z",
        },
      };
      await expect(
        store.replaceTemplate(revised, "welcome", 1),
      ).resolves.toBe(true);
      await expect(store.getTemplate("welcome")).resolves.toBeUndefined();
      await expect(store.getTemplate("greeting")).resolves.toEqual(revised);

      const published: TemplateRecord = {
        ...revised,
        revision: 3,
        updated_at: "2030-01-01T00:02:00.000Z",
        published: structuredClone(revised.draft),
        published_at: "2030-01-01T00:02:00.000Z",
      };
      const publication: TemplatePublicationRecord = {
        id: revised.draft.id,
        template_id: revised.id,
        version: structuredClone(revised.draft),
        published_at: published.published_at!,
        expires_at: "2099-01-01T00:00:00.000Z",
        actor: { id: "key_123", name: "Release automation" },
        source: "cli",
      };
      await expect(
        store.publishTemplate(published, publication, undefined, 2, 2),
      ).resolves.toBe(true);
      await expect(
        store.getPublishedTemplate("greeting"),
      ).resolves.toEqual(published);
      await expect(
        store.listTemplateVersions(
          published.id,
          20,
          undefined,
          Math.floor(Date.parse("2030-01-01T00:00:00.000Z") / 1_000),
        ),
      ).resolves.toMatchObject({
        data: [{ id: publication.id }],
        has_more: false,
      });

      await expect(
        store.createTemplate(template("tmpl_conflict", "greeting")),
      ).rejects.toThrow("alias is already in use");
      await expect(
        store.deleteTemplate(published, 2),
      ).resolves.toBe(false);
      await expect(
        store.deleteTemplate(published, 3),
      ).resolves.toBe(true);
      await expect(store.getTemplate(published.id)).resolves.toBeUndefined();
      await expect(
        store.getTemplateVersion(published.id, publication.id),
      ).resolves.toBeUndefined();
    });
  });

  describe("portable application resources", () => {
    it("persists attachments and coordinates inbound claims and retention", async () => {
      const attachment: AttachmentUploadRecord = {
        id: "attachment_123",
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size_bytes: 123,
        checksum_sha256: "b".repeat(64),
        object_key: "attachments/attachment_123",
        upload_token_hash: "c".repeat(64),
        created_at: "2030-01-01T00:00:00.000Z",
        upload_expires_at: "2030-01-01T00:15:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
      };
      await store.putAttachmentUpload(attachment);
      await expect(
        store.getAttachmentUpload(attachment.id),
      ).resolves.toEqual(attachment);

      const [left, right] = await Promise.all([
        store.claimReceivedEmail("recv_claim", 100, 200, 300),
        store.claimReceivedEmail("recv_claim", 100, 200, 300),
      ]);
      expect([left, right].filter(Boolean)).toHaveLength(1);
      await store.releaseReceivedEmailClaim("recv_claim", 199);
      await expect(
        store.claimReceivedEmail("recv_claim", 101, 201, 301),
      ).resolves.toBe(false);
      await store.releaseReceivedEmailClaim("recv_claim", 200);
      await expect(
        store.claimReceivedEmail("recv_claim", 101, 201, 301),
      ).resolves.toBe(true);

      const active = received(
        "recv_active",
        "2099-01-08T00:00:00.000Z",
      );
      const expired = received(
        "recv_expired",
        "2020-01-08T00:00:00.000Z",
      );
      await expect(store.createReceivedEmail(active)).resolves.toBe(true);
      await expect(store.createReceivedEmail(active)).resolves.toBe(false);
      await store.createReceivedEmail(expired);
      await expect(
        store.updateReceivedEmail(active.id, {
          webhook_queued_at: "2030-01-01T00:01:00.000Z",
        }),
      ).resolves.toMatchObject({
        id: active.id,
        webhook_queued_at: "2030-01-01T00:01:00.000Z",
      });
      await expect(store.listReceivedEmails(20)).resolves.toMatchObject({
        data: [{ id: active.id }],
        has_more: false,
      });
      await expect(
        store.listReceivedEmails(20, expired.id),
      ).rejects.toMatchObject({ name: "validation_error" });
    });

    it("supports domain, webhook, API-key, and suppression CRUD", async () => {
      const domain: DomainRecord = {
        id: "domain_123",
        name: "example.com",
        status: "pending",
        region: "global",
        records: [],
        created_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
      };
      await store.createDomain(domain);
      await expect(
        store.updateDomain(domain.id, {
          status: "verified",
          updated_at: "2030-01-01T00:01:00.000Z",
        }),
      ).resolves.toMatchObject({ status: "verified" });
      await expect(store.listDomains(20)).resolves.toMatchObject({
        data: [{ id: domain.id }],
      });

      const webhook: WebhookEndpoint = {
        id: "wh_123",
        endpoint: "https://example.net/webhook",
        events: ["email.sent"],
        signing_secret: "secret",
        status: "enabled",
        created_at: "2030-01-01T00:00:00.000Z",
      };
      await store.createWebhook(webhook);
      await expect(
        store.updateWebhook(webhook.id, { status: "disabled" }),
      ).resolves.toMatchObject({ status: "disabled" });
      const delivery = webhookDelivery("msg_123", webhook.id);
      const other = webhookDelivery("msg_other", "wh_other");
      await store.createWebhookDelivery(delivery);
      await store.createWebhookDelivery(other);
      await expect(
        store.updateWebhookDelivery(delivery.id, {
          status: "succeeded",
          attempts: 1,
          response_status: 204,
          updated_at: "2099-01-01T00:01:00.000Z",
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
        response_status: 204,
      });
      await expect(
        store.listWebhookDeliveries(webhook.id, 20),
      ).resolves.toMatchObject({
        data: [{ id: delivery.id }],
        has_more: false,
      });
      await expect(
        store.listWebhookDeliveries(webhook.id, 20, other.id),
      ).rejects.toMatchObject({ name: "validation_error" });

      const apiKey: ApiKeyRecord = {
        id: "key_123",
        name: "Production",
        prefix: "re_prod",
        key_hash: "d".repeat(64),
        scopes: ["emails:send"],
        created_at: "2030-01-01T00:00:00.000Z",
      };
      await store.createApiKey(apiKey);
      await expect(
        store.updateApiKey(apiKey.id, {
          revoked_at: "2030-01-02T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        id: apiKey.id,
        revoked_at: "2030-01-02T00:00:00.000Z",
      });
      await expect(store.listApiKeys(20)).resolves.toMatchObject({
        data: [{ id: apiKey.id }],
      });

      const suppression: SuppressionRecord = {
        id: "hash_recipient",
        email: "recipient@example.net",
        reason: "manual",
        created_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
      };
      await store.putSuppression(suppression);
      await store.putSuppression({
        ...suppression,
        detail: "operator request",
        updated_at: "2030-01-01T00:01:00.000Z",
      });
      await expect(
        store.getSuppression(suppression.id),
      ).resolves.toMatchObject({ detail: "operator request" });
      await expect(store.listSuppressions(20)).resolves.toMatchObject({
        data: [{ id: suppression.id }],
      });

      await expect(store.deleteSuppression(suppression.id)).resolves.toBe(
        true,
      );
      await expect(store.deleteWebhook(webhook.id)).resolves.toBe(true);
      await expect(store.deleteDomain(domain.id)).resolves.toBe(true);
    });
  });
}
