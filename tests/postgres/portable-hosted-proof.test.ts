import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { migratePostgres } from "../../src/adapters/postgres/postgres-migrations.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import {
  runPortableHostedProof,
  type PortableHostedProofOptions,
} from "../../src/portable/hosted-proof.js";
import { PortableWorker } from "../../src/portable/worker.js";
import {
  createPortableRuntime,
  type PortableRuntime,
} from "../../src/runtime.js";

const databaseUrl = process.env.HAYASEND_POSTGRES_TEST_URL;
const apiKey = "re_portable_hosted_proof_test_key";

if (!databaseUrl) {
  describe.skip("portable hosted semantic proof", () => {
    it("requires HAYASEND_POSTGRES_TEST_URL", () => {});
  });
} else {
  const postgresTestUrl = databaseUrl;
  const pool = new Pool({ connectionString: postgresTestUrl, max: 12 });
  const config = loadConfig({
    HAYASEND_MODE: "portable",
    HAYASEND_DATABASE_URL: postgresTestUrl,
    HAYASEND_API_KEY: apiKey,
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

  function proofOptions(
    overrides: Partial<PortableHostedProofOptions> = {},
  ): PortableHostedProofOptions {
    const app = createApp(runtime, {
      readiness: () => runtime.checkReadiness(),
    });
    return {
      api_url: "https://proof.example.invalid",
      api_key: apiKey,
      database_url: postgresTestUrl,
      confirmation: "isolated-non-sending",
      transport: "console",
      schedule_days: 30,
      timeout_seconds: 10,
      run_id: "proof_0123456789abcdef",
      fetch: async (input, init) => {
        const raw =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const url = new URL(raw);
        return app.request(`${url.pathname}${url.search}`, init);
      },
      wait: async () => undefined,
      after_due_advance: async () => {
        const worker = new PortableWorker(runtime, runtime.jobQueue, {
          owner: "portable-hosted-proof-test-worker",
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

  it("proves a 30-day schedule after losing its wake-up and cleans up", async () => {
    const evidence = await runPortableHostedProof(proofOptions());

    expect(evidence).toMatchObject({
      object: "portable_hosted_semantic_proof",
      schema_version: "1.0.0",
      run_id: "proof_0123456789abcdef",
      transport: "portable-console",
      database: {
        engine: "postgresql",
        connection_verified: true,
      },
      checks: {
        health: true,
        readiness: true,
        exact_runtime_version: true,
        isolated_empty_database: true,
        atomic_delivery_commit: true,
        idempotency_replay: true,
        schedule_exceeds_seven_days: true,
        durable_delayed_job_present: true,
        lost_wakeup_jobs_removed: 1,
        authoritative_due_row_advanced: true,
        periodic_sweeper_recovered: true,
        email_state: "sent",
        message_state: "accepted",
        recipient_state: "accepted",
        provider_attempt_state: "accepted",
        provider_acceptance_only: true,
        terminal_delivery_claimed: false,
        external_send_performed: false,
        provider_events_observed: 0,
      },
      cleanup: {
        retained_by_explicit_operator_request: false,
        fixture_rows_remaining: 0,
        complete: true,
      },
      privacy: {
        credentials_included: false,
        addresses_included: false,
        content_included: false,
        raw_errors_included: false,
      },
    });
    expect(evidence.checks.scheduled_horizon_seconds).toBe(
      30 * 24 * 60 * 60,
    );

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(postgresTestUrl);
    expect(serialized).not.toContain("proof-sender@example.com");
    expect(serialized).not.toContain("proof-recipient@example.net");
    expect(serialized).not.toContain("Isolated console-only");

    const remaining = await pool.query<{
      emails: string;
      jobs: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM emails) AS emails,
         (SELECT count(*)::text FROM jobs) AS jobs`,
    );
    expect(remaining.rows[0]).toEqual({
      emails: "0",
      jobs: "0",
    });
  });

  it("refuses any sending transport before touching the API or database", async () => {
    await expect(
      runPortableHostedProof(
        proofOptions({
          transport: "sendgrid",
          fetch: async () => {
            throw new Error("fetch must not run");
          },
        }),
      ),
    ).rejects.toThrow("requires the non-sending console transport");
  });

  it("refuses missing database credentials before touching the API or database", async () => {
    await expect(
      runPortableHostedProof(
        proofOptions({
          database_url: "",
          fetch: async () => {
            throw new Error("fetch must not run");
          },
        }),
      ),
    ).rejects.toThrow("Hosted proof credentials are missing");
  });

  it("refuses an isolated database that contains any application entity", async () => {
    await pool.query(
      `INSERT INTO app_entities(
         kind,
         id,
         entity,
         created_at,
         updated_at
       ) VALUES (
         'domain',
         'domain_unrelated_fixture',
         '{}'::jsonb,
         now(),
         now()
       )`,
    );
    await expect(
      runPortableHostedProof(
        proofOptions({
          fetch: async () => {
            throw new Error("fetch must not run");
          },
        }),
      ),
    ).rejects.toThrow("requires an empty isolated application database");
    const remaining = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app_entities",
    );
    expect(remaining.rows[0]?.count).toBe("1");
  });

  it("removes the first atomic fixture when the idempotent replay fails", async () => {
    const options = proofOptions();
    const delegate = options.fetch!;
    let createRequests = 0;
    options.fetch = async (input, init) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(raw);
      if (url.pathname === "/emails" && init?.method === "POST") {
        createRequests += 1;
        if (createRequests === 2) {
          return new Response(null, { status: 503 });
        }
      }
      return delegate(input, init);
    };

    await expect(runPortableHostedProof(options)).rejects.toThrow(
      "API request failed with 503",
    );
    const remaining = await pool.query<{
      emails: string;
      outbox: string;
      jobs: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM emails) AS emails,
         (SELECT count(*)::text FROM outbox_items) AS outbox,
         (SELECT count(*)::text FROM jobs) AS jobs`,
    );
    expect(remaining.rows[0]).toEqual({
      emails: "0",
      outbox: "0",
      jobs: "0",
    });
  });

  it("discovers and removes a commit whose first API response was lost", async () => {
    const options = proofOptions();
    const delegate = options.fetch!;
    let responseLost = false;
    options.fetch = async (input, init) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(raw);
      const response = await delegate(input, init);
      if (
        !responseLost &&
        url.pathname === "/emails" &&
        init?.method === "POST"
      ) {
        responseLost = true;
        return new Response(null, { status: 503 });
      }
      return response;
    };

    await expect(runPortableHostedProof(options)).rejects.toThrow(
      "API request failed with 503",
    );
    const remaining = await pool.query<{
      emails: string;
      idempotency: string;
      outbox: string;
      jobs: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM emails) AS emails,
         (SELECT count(*)::text FROM idempotency_claims) AS idempotency,
         (SELECT count(*)::text FROM outbox_items) AS outbox,
         (SELECT count(*)::text FROM jobs) AS jobs`,
    );
    expect(remaining.rows[0]).toEqual({
      emails: "0",
      idempotency: "0",
      outbox: "0",
      jobs: "0",
    });
  });

  it("requires a second explicit guard before retaining a fixture", async () => {
    await expect(
      runPortableHostedProof(
        proofOptions({
          retain_fixture: true,
        }),
      ),
    ).rejects.toThrow("Retaining the fixture requires");
  });
}
