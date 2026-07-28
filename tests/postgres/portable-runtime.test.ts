import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migratePostgres } from "../../src/adapters/postgres/postgres-migrations.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { PortableWorker } from "../../src/portable/worker.js";
import {
  createPortableRuntime,
  type PortableRuntime,
} from "../../src/runtime.js";

const databaseUrl = process.env.HAYASEND_POSTGRES_TEST_URL;

if (!databaseUrl) {
  describe.skip("portable PostgreSQL runtime", () => {
    it("requires HAYASEND_POSTGRES_TEST_URL", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const config = loadConfig({
    HAYASEND_MODE: "portable",
    HAYASEND_DATABASE_URL: databaseUrl,
    HAYASEND_API_KEY: "re_portable_runtime_test_key",
    HAYASEND_TRANSPORT: "console",
  });
  let runtime: PortableRuntime;

  beforeAll(async () => {
    await migratePostgres(pool);
    runtime = createPortableRuntime(config, pool);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE
         jobs,
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
    await runtime.close();
  });

  it("queues through the API and completes delivery in a separate worker", async () => {
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    const app = createApp(runtime, {
      readiness: () => runtime.checkReadiness(),
    });
    const response = await app.request("/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer re_portable_runtime_test_key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "HayaSend <sender@example.com>",
        to: ["recipient@example.net"],
        subject: "Portable runtime",
        text: "PostgreSQL API and worker separation.",
      }),
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as { id: string };
    await expect(runtime.emailService.get(created.id)).resolves.toMatchObject({
      status: "queued",
    });

    const worker = new PortableWorker(runtime, runtime.jobQueue, {
      owner: "portable-runtime-test-worker",
      concurrency: 4,
      log: () => undefined,
    });
    const result = await worker.tick();
    expect(result).toMatchObject({
      leased: 2,
      completed: 2,
      failed: 0,
      lost: 0,
    });
    await expect(runtime.emailService.get(created.id)).resolves.toMatchObject({
      status: "sent",
      provider_id: `local_${created.id}`,
    });
    await expect(runtime.jobQueue.getQueueDiagnostics()).resolves.toMatchObject({
      provider: "postgresql",
      primary: { total: 0 },
    });
  });

  it("fails direct uploads before retaining metadata when object storage is absent", async () => {
    const app = createApp(runtime);
    const response = await app.request("/attachments", {
      method: "POST",
      headers: {
        authorization: "Bearer re_portable_runtime_test_key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "portable.txt",
        content_type: "text/plain",
        size_bytes: 1,
        checksum_sha256: "a".repeat(64),
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      name: "attachment_storage_not_configured",
    });
    const retained = await pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM app_entities WHERE kind = 'attachment_upload'",
    );
    expect(retained.rows[0]?.total).toBe("0");
  });
}
