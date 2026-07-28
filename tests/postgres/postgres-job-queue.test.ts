import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresJobQueue,
  type PostgresLeasedJob,
} from "../../src/adapters/postgres/postgres-job-queue.js";
import { migratePostgres } from "../../src/adapters/postgres/postgres-migrations.js";

const databaseUrl = process.env.HAYASEND_POSTGRES_TEST_URL;

if (!databaseUrl) {
  describe.skip("PostgreSQL durable jobs", () => {
    it("requires HAYASEND_POSTGRES_TEST_URL", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  let now = new Date("2030-01-01T00:00:00.000Z");
  const queue = new PostgresJobQueue(pool, {
    max_attempts: 2,
    now: () => now,
  });

  beforeAll(async () => {
    await migratePostgres(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE jobs");
    now = new Date("2030-01-01T00:00:00.000Z");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("deduplicates publication and preserves the earliest wake-up", async () => {
    const job = {
      type: "send_email" as const,
      email_id: "email_postgres_job_000000000000001",
      job_id: "outbox:postgres:one",
    };
    await queue.enqueue(job, 60);
    await queue.enqueue(job, 10);

    const stored = await pool.query<{
      id: string;
      available_at: Date;
      envelope: { job: typeof job };
    }>("SELECT id, available_at, envelope FROM jobs");
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      id: `job:v1:send-email:${job.job_id}`,
      envelope: { job },
    });
    expect(stored.rows[0]?.available_at.toISOString()).toBe(
      "2030-01-01T00:00:10.000Z",
    );

    await expect(
      queue.enqueue({
        ...job,
        email_id: "email_postgres_job_000000000000002",
      }),
    ).rejects.toThrow("different job");
    await expect(
      queue.enqueue({
        type: "send_email",
        email_id: "email_postgres_job_000000000000002",
        job_id: "x".repeat(2_049),
      }),
    ).rejects.toThrow("job IDs must not exceed 2048 bytes");
  });

  it("leases due jobs once across competing workers and recovers expiry", async () => {
    await queue.enqueue({
      type: "send_email",
      email_id: "email_postgres_job_000000000000003",
    });
    const [left, right] = await Promise.all([
      queue.lease({
        owner: "worker-left",
        lease_seconds: 30,
        limit: 1,
        now,
      }),
      queue.lease({
        owner: "worker-right",
        lease_seconds: 30,
        limit: 1,
        now,
      }),
    ]);
    expect([...left, ...right]).toHaveLength(1);
    const first = [...left, ...right][0] as PostgresLeasedJob;
    expect(first.attempt).toBe(1);
    expect(first.lease_expires_at).toBe("2030-01-01T00:00:30.000Z");

    const firstOwner = left.length === 1 ? "worker-left" : "worker-right";
    expect(
      await queue.acknowledge(first.id, "unrelated-worker", now),
    ).toBe(false);
    now = new Date("2030-01-01T00:00:10.000Z");
    expect(await queue.extendLease(first.id, firstOwner, 60, now)).toBe(true);
    now = new Date("2030-01-01T00:00:31.000Z");
    expect(
      await queue.lease({
        owner: "early-recovery-worker",
        lease_seconds: 30,
        limit: 1,
        now,
      }),
    ).toEqual([]);
    now = new Date("2030-01-01T00:01:11.000Z");
    const recovered = await queue.lease({
      owner: "recovery-worker",
      lease_seconds: 30,
      limit: 1,
      now,
    });
    expect(recovered).toMatchObject([{ id: first.id, attempt: 2 }]);
    expect(await queue.acknowledge(first.id, firstOwner, now)).toBe(false);
    expect(await queue.acknowledge(first.id, "recovery-worker", now)).toBe(
      true,
    );
  });

  it("retries transient failures and terminally isolates permanent failures", async () => {
    await queue.enqueue({
      type: "deliver_webhook",
      webhook_id: "wh_postgres_job_00000000000000001",
      delivery_id: "whd_postgres_job_0000000000000001",
      event: {
        type: "email.sent",
        created_at: now.toISOString(),
        data: {
          created_at: now.toISOString(),
          email_id: "email_postgres_job_000000000000004",
          from: "sender@example.com",
          to: ["private-recipient@example.net"],
          subject: "Private subject",
        },
      },
    });
    const [first] = await queue.lease({
      owner: "worker-retry",
      lease_seconds: 30,
      limit: 1,
      now,
    });
    expect(first).toBeDefined();
    await expect(
      queue.recordFailure(
        first!.id,
        "worker-retry",
        "recipient@example.net" as never,
        { retry_delay_seconds: 15, now },
      ),
    ).rejects.toThrow("privacy-safe");
    expect(
      await queue.recordFailure(
        first!.id,
        "worker-retry",
        "provider_unavailable",
        { retry_delay_seconds: 15, now },
      ),
    ).toBe("retry_scheduled");
    expect((await queue.getQueueDiagnostics(now)).primary.delayed).toBe(1);

    now = new Date("2030-01-01T00:00:16.000Z");
    const [second] = await queue.lease({
      owner: "worker-retry",
      lease_seconds: 30,
      limit: 1,
      now,
    });
    expect(second).toMatchObject({ id: first!.id, attempt: 2 });
    expect(
      await queue.recordFailure(
        second!.id,
        "worker-retry",
        "provider_unavailable",
        { retry_delay_seconds: 15, now },
      ),
    ).toBe("terminal_failure");

    const diagnostics = await queue.getQueueDiagnostics(now);
    expect(diagnostics).toMatchObject({
      provider: "postgresql",
      primary: { total: 0 },
      dead_letters: {
        delivery: { visible: 1, total: 1 },
        scheduler: { total: 0 },
        inbound: { total: 0 },
      },
    });
    const stored = await pool.query<{
      envelope: unknown;
      last_diagnostic_category: string;
    }>(
      "SELECT envelope, last_diagnostic_category FROM jobs WHERE id = $1",
      [first!.id],
    );
    expect(stored.rows[0]?.last_diagnostic_category).toBe(
      "provider_unavailable",
    );
    expect(JSON.stringify(stored.rows[0]?.last_diagnostic_category)).not.toContain(
      "private-recipient",
    );
    expect(await queue.recoverFailed("job-missing", now)).toBe(false);
    expect(await queue.recoverFailed(first!.id, now)).toBe(true);
    await expect(queue.getQueueDiagnostics(now)).resolves.toMatchObject({
      primary: { visible: 1, total: 1 },
      dead_letters: { delivery: { total: 0 } },
    });
  });

  it("releases owned leases and prunes only expired finished jobs", async () => {
    await queue.enqueue({
      type: "reconcile_outbox",
      outbox_id: "outbox:postgres:release",
    });
    const [leased] = await queue.lease({
      owner: "worker-shutdown",
      lease_seconds: 60,
      limit: 1,
      now,
    });
    expect(leased).toBeDefined();
    expect(await queue.releaseOwnedLeases("worker-shutdown", now)).toBe(1);
    const [reLeased] = await queue.lease({
      owner: "worker-finish",
      lease_seconds: 60,
      limit: 1,
      now,
    });
    expect(await queue.acknowledge(reLeased!.id, "worker-finish", now)).toBe(
      true,
    );
    expect(
      await queue.pruneFinished(new Date("2029-12-31T23:59:59.000Z")),
    ).toBe(0);
    expect(
      await queue.pruneFinished(new Date("2030-01-01T00:00:01.000Z")),
    ).toBe(1);
  });
}
