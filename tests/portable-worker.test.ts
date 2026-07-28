import { ValidationError } from "../src/core/errors.js";
import type { SafeErrorCategory } from "../src/core/error-telemetry.js";
import type { Job } from "../src/core/types.js";
import {
  PortableWorker,
  type PortableWorkerQueue,
  type PortableWorkerRuntime,
} from "../src/portable/worker.js";
import type {
  PostgresFailureDisposition,
  PostgresLeasedJob,
  PostgresLeaseOptions,
} from "../src/adapters/postgres/postgres-job-queue.js";
import { describe, expect, it } from "vitest";

class FakeQueue implements PortableWorkerQueue {
  readonly acknowledgements: Array<{ id: string; owner: string }> = [];
  readonly failures: Array<{
    id: string;
    owner: string;
    category: SafeErrorCategory;
    terminal: boolean;
  }> = [];
  readonly releases: string[] = [];
  readonly pruneBefore: Date[] = [];
  jobs: PostgresLeasedJob[] = [];

  async lease(_options: PostgresLeaseOptions): Promise<PostgresLeasedJob[]> {
    return this.jobs.splice(0);
  }

  async acknowledge(id: string, owner: string): Promise<boolean> {
    this.acknowledgements.push({ id, owner });
    return true;
  }

  async extendLease(
    _id: string,
    _owner: string,
    _leaseSeconds: number,
  ): Promise<boolean> {
    return true;
  }

  async recordFailure(
    id: string,
    owner: string,
    category: SafeErrorCategory,
    options: {
      retry_delay_seconds: number;
      terminal?: boolean | undefined;
    },
  ): Promise<PostgresFailureDisposition> {
    this.failures.push({
      id,
      owner,
      category,
      terminal: options.terminal === true,
    });
    return options.terminal === true
      ? "terminal_failure"
      : "retry_scheduled";
  }

  async releaseOwnedLeases(owner: string): Promise<number> {
    this.releases.push(owner);
    return 1;
  }

  async pruneFinished(before: Date): Promise<number> {
    this.pruneBefore.push(before);
    return 0;
  }
}

function leased(id: string, job: Job, attempt = 1): PostgresLeasedJob {
  return {
    id,
    job,
    attempt,
    lease_expires_at: "2030-01-01T00:01:00.000Z",
  };
}

describe("portable PostgreSQL worker", () => {
  it("reconciles the outbox and acknowledges successful jobs", async () => {
    const queue = new FakeQueue();
    queue.jobs = [
      leased("job-success", {
        type: "send_email",
        email_id: "email_portable_worker_00000000001",
      }),
    ];
    const processed: Array<{ job: Job; attempt: number }> = [];
    const reconciled: string[] = [];
    const runtime: PortableWorkerRuntime = {
      async dispatchOutbox(now) {
        reconciled.push(now!.toISOString());
      },
      async processJob(job, attempt = 1) {
        processed.push({ job, attempt });
      },
    };
    const worker = new PortableWorker(runtime, queue, {
      owner: "portable-worker-one",
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      log: () => undefined,
    });

    await expect(worker.tick()).resolves.toEqual({
      leased: 1,
      completed: 1,
      retried: 0,
      failed: 0,
      lost: 0,
    });
    expect(reconciled).toEqual(["2030-01-01T00:00:00.000Z"]);
    expect(processed).toMatchObject([{ attempt: 1 }]);
    expect(queue.acknowledgements).toEqual([
      { id: "job-success", owner: "portable-worker-one" },
    ]);
    expect(queue.pruneBefore[0]?.toISOString()).toBe(
      "2029-12-25T00:00:00.000Z",
    );
  });

  it("retries transient failures and terminally isolates permanent ones", async () => {
    const queue = new FakeQueue();
    queue.jobs = [
      leased("job-transient", {
        type: "send_email",
        email_id: "email_portable_worker_00000000002",
      }),
      leased("job-permanent", {
        type: "send_email",
        email_id: "email_portable_worker_00000000003",
      }),
    ];
    const runtime: PortableWorkerRuntime = {
      async dispatchOutbox() {},
      async processJob(job) {
        if (
          job.type === "send_email" &&
          job.email_id.endsWith("00000000003")
        ) {
          throw new ValidationError("private recipient@example.net");
        }
        const error = new Error("private provider endpoint");
        Object.assign(error, { code: "ECONNRESET" });
        throw error;
      },
    };
    const worker = new PortableWorker(runtime, queue, {
      owner: "portable-worker-two",
      concurrency: 2,
      log: () => undefined,
    });

    await expect(worker.tick()).resolves.toMatchObject({
      leased: 2,
      retried: 1,
      failed: 1,
    });
    expect(queue.failures).toEqual([
      {
        id: "job-transient",
        owner: "portable-worker-two",
        category: "network_reset",
        terminal: false,
      },
      {
        id: "job-permanent",
        owner: "portable-worker-two",
        category: "application_error",
        terminal: true,
      },
    ]);
    expect(JSON.stringify(queue.failures)).not.toContain("recipient@example");
    expect(JSON.stringify(queue.failures)).not.toContain("provider endpoint");
  });

  it("releases owned leases when shutdown interrupts the poll wait", async () => {
    const queue = new FakeQueue();
    const controller = new AbortController();
    const runtime: PortableWorkerRuntime = {
      async dispatchOutbox() {},
      async processJob() {},
    };
    const worker = new PortableWorker(runtime, queue, {
      owner: "portable-worker-shutdown",
      log: () => undefined,
      wait: async (_milliseconds, signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
      },
    });

    await worker.run(controller.signal);
    expect(queue.releases).toEqual(["portable-worker-shutdown"]);
  });
});
