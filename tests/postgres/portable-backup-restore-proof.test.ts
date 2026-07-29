import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { MemoryAttachmentStorage } from "../../src/adapters/attachment-storage.js";
import { migratePostgres } from "../../src/adapters/postgres/postgres-migrations.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import {
  seedPortableBackupRestoreProof,
  verifyPortableBackupRestoreProof,
  type PortableBackupRestoreSeedOptions,
  type PortableBackupRestoreVerifyOptions,
} from "../../src/portable/backup-restore-proof.js";
import { PortableWorker } from "../../src/portable/worker.js";
import {
  createPortableRuntime,
  type PortableRuntime,
} from "../../src/runtime.js";

const databaseUrl = process.env.HAYASEND_POSTGRES_TEST_URL;
const apiKey = "re_portable_backup_restore_test_key";

if (!databaseUrl) {
  describe.skip("portable backup and restore proof", () => {
    it("requires HAYASEND_POSTGRES_TEST_URL", () => {});
  });
} else {
  const postgresTestUrl = databaseUrl;
  const pool = new Pool({ connectionString: postgresTestUrl, max: 12 });
  const storage = new MemoryAttachmentStorage();
  const config = loadConfig({
    HAYASEND_MODE: "portable",
    HAYASEND_DATABASE_URL: postgresTestUrl,
    HAYASEND_API_KEY: apiKey,
    HAYASEND_TRANSPORT: "console",
  });
  let runtime: PortableRuntime;

  beforeAll(async () => {
    await migratePostgres(pool);
    runtime = createPortableRuntime(config, pool, storage);
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

  function fetchFromApp() {
    const app = createApp(runtime, {
      readiness: () => runtime.checkReadiness(),
    });
    return async (input: string | URL | Request, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(raw);
      return app.request(`${url.pathname}${url.search}`, init);
    };
  }

  function seedOptions(
    overrides: Partial<PortableBackupRestoreSeedOptions> = {},
  ): PortableBackupRestoreSeedOptions {
    return {
      api_url: "https://proof.example.invalid",
      api_key: apiKey,
      database_url: postgresTestUrl,
      confirmation: "isolated-backup-restore-proof",
      retain_confirmation: "retain-isolated-backup-fixture",
      transport: "console",
      schedule_days: 30,
      run_id: "restore_0123456789abcdef",
      attachment_content: new TextEncoder().encode(
        "private backup restore attachment fixture",
      ),
      fetch: fetchFromApp(),
      ...overrides,
    };
  }

  function restoreOptions(
    source: Awaited<ReturnType<typeof seedPortableBackupRestoreProof>>,
    overrides: Partial<PortableBackupRestoreVerifyOptions> = {},
  ): PortableBackupRestoreVerifyOptions {
    return {
      api_url: "https://restored.example.invalid",
      api_key: apiKey,
      database_url: postgresTestUrl,
      confirmation: "isolated-backup-restore-proof",
      transport: "console",
      source,
      timeout_seconds: 10,
      fetch: fetchFromApp(),
      wait: async () => undefined,
      after_due_advance: async () => {
        const worker = new PortableWorker(runtime, runtime.jobQueue, {
          owner: "portable-backup-restore-test-worker",
          concurrency: 4,
          log: () => undefined,
        });
        const result = await worker.tick();
        expect(result).toMatchObject({
          leased: 1,
          completed: 1,
          failed: 0,
          lost: 0,
        });
      },
      ...overrides,
    };
  }

  it("rehashes a restored attachment and recovers due work without sending", async () => {
    const source = await seedPortableBackupRestoreProof(seedOptions());

    expect(source).toMatchObject({
      object: "portable_backup_restore_seed_proof",
      schema_version: "1.0.0",
      run_id: "restore_0123456789abcdef",
      transport: "portable-console",
      checks: {
        isolated_empty_database: true,
        atomic_scheduled_fixture: true,
        idempotency_replay: true,
        schedule_exceeds_seven_days: true,
        durable_delayed_job_present: true,
        attachment_direct_upload: true,
        attachment_checksum_bound: true,
        retained_for_isolated_backup: true,
        external_send_performed: false,
      },
    });
    expect(source.fixture.state_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.fixture.attachment_sha256).toMatch(/^[a-f0-9]{64}$/);

    const restored = await verifyPortableBackupRestoreProof(
      restoreOptions(source),
    );

    expect(restored).toMatchObject({
      object: "portable_backup_restore_proof",
      schema_version: "1.0.0",
      run_id: source.run_id,
      source_state_sha256: source.fixture.state_sha256,
      restored_state_sha256: source.fixture.state_sha256,
      transport: "portable-console",
      checks: {
        restored_state_matches_source: true,
        restored_attachment_reference_matches_source: true,
        restored_attachment_bytes_rehashed_by_runtime: true,
        lost_wakeup_jobs_removed: 1,
        authoritative_due_row_advanced: true,
        periodic_sweeper_recovered: true,
        email_state: "sent",
        message_state: "accepted",
        provider_attempt_state: "accepted",
        provider_acceptance_only: true,
        terminal_delivery_claimed: false,
        external_send_performed: false,
      },
      cleanup: {
        database_fixture_rows_remaining: 0,
        complete: true,
        object_cleanup_delegated_to_provider: true,
      },
      privacy: {
        credentials_included: false,
        addresses_included: false,
        content_included: false,
        upload_url_included: false,
        raw_errors_included: false,
      },
    });

    const serialized = JSON.stringify({ source, restored });
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(postgresTestUrl);
    expect(serialized).not.toContain("proof-sender@example.com");
    expect(serialized).not.toContain("proof-recipient@example.net");
    expect(serialized).not.toContain(
      "private backup restore attachment fixture",
    );
    const remaining = await pool.query<{
      emails: string;
      attachments: string;
      jobs: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM emails) AS emails,
         (
           SELECT count(*)::text
           FROM app_entities
           WHERE kind = 'attachment_upload'
         ) AS attachments,
         (SELECT count(*)::text FROM jobs) AS jobs`,
    );
    expect(remaining.rows[0]).toEqual({
      emails: "0",
      attachments: "0",
      jobs: "0",
    });
  });

  it("rejects a changed restored fixture and removes its database rows", async () => {
    const source = await seedPortableBackupRestoreProof(seedOptions());
    await pool.query(
      `UPDATE app_entities
       SET entity = jsonb_set(
         entity,
         '{checksum_sha256}',
         to_jsonb($2::text),
         false
       )
       WHERE kind = 'attachment_upload' AND id = $1`,
      [source.fixture.attachment_id, "0".repeat(64)],
    );

    await expect(
      verifyPortableBackupRestoreProof(restoreOptions(source)),
    ).rejects.toThrow("scheduled fixture does not match its guards");

    const remaining = await pool.query<{ total: string }>(
      `SELECT (
         (SELECT count(*) FROM emails) +
         (
           SELECT count(*)
           FROM app_entities
           WHERE kind = 'attachment_upload'
         )
       )::text AS total`,
    );
    expect(remaining.rows[0]?.total).toBe("0");
  });

  it("refuses a sending transport before touching the API or database", async () => {
    await expect(
      seedPortableBackupRestoreProof(
        seedOptions({
          transport: "sendgrid",
          fetch: async () => {
            throw new Error("fetch must not run");
          },
        }),
      ),
    ).rejects.toThrow("requires the non-sending console transport");
  });

  it("requires explicit retention confirmation before seeding", async () => {
    await expect(
      seedPortableBackupRestoreProof(
        seedOptions({
          retain_confirmation: "",
          fetch: async () => {
            throw new Error("fetch must not run");
          },
        }),
      ),
    ).rejects.toThrow("retain-isolated-backup-fixture");
  });
}
