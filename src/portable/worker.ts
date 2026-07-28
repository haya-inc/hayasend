import { fileURLToPath } from "node:url";
import { createPostgresPool } from "../adapters/postgres/postgres-pool.js";
import type {
  PostgresFailureDisposition,
  PostgresLeasedJob,
  PostgresLeaseOptions,
} from "../adapters/postgres/postgres-job-queue.js";
import { loadConfig, type Config } from "../config.js";
import { createId } from "../core/crypto.js";
import {
  safeErrorCategory,
  shouldRetryOperationalError,
  type SafeErrorCategory,
} from "../core/error-telemetry.js";
import type { Job } from "../core/types.js";
import {
  createPortableRuntime,
  type PortableRuntime,
} from "../runtime.js";

const SAFE_DIAGNOSTIC_CATEGORIES = new Set<SafeErrorCategory>([
  "application_error",
  "invalid_data",
  "network_dns",
  "network_refused",
  "network_reset",
  "provider_error",
  "provider_rejected",
  "provider_throttled",
  "provider_unavailable",
  "timeout",
]);

export interface PortableWorkerRuntime {
  processJob(job: Job, attempt?: number): Promise<void>;
  dispatchOutbox(now?: Date): Promise<unknown>;
}

export interface PortableWorkerQueue {
  lease(options: PostgresLeaseOptions): Promise<PostgresLeasedJob[]>;
  acknowledge(id: string, owner: string, now?: Date): Promise<boolean>;
  extendLease(
    id: string,
    owner: string,
    leaseSeconds: number,
    now?: Date,
  ): Promise<boolean>;
  recordFailure(
    id: string,
    owner: string,
    category: SafeErrorCategory,
    options: {
      retry_delay_seconds: number;
      terminal?: boolean | undefined;
      now?: Date | undefined;
    },
  ): Promise<PostgresFailureDisposition>;
  releaseOwnedLeases(owner: string, now?: Date): Promise<number>;
  pruneFinished(before: Date, limit?: number): Promise<number>;
}

export interface PortableWorkerOptions {
  owner?: string | undefined;
  concurrency?: number | undefined;
  lease_seconds?: number | undefined;
  poll_interval_ms?: number | undefined;
  retry_delay_seconds?: number | undefined;
  outbox_interval_ms?: number | undefined;
  job_retention_days?: number | undefined;
  now?: (() => Date) | undefined;
  wait?:
    | ((milliseconds: number, signal: AbortSignal) => Promise<void>)
    | undefined;
  log?:
    | ((entry: Record<string, string | number | boolean>) => void)
    | undefined;
}

export interface PortableWorkerTickResult {
  leased: number;
  completed: number;
  retried: number;
  failed: number;
  lost: number;
}

function validateInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

function diagnosticCategory(error: unknown): SafeErrorCategory {
  const category = safeErrorCategory(error);
  return SAFE_DIAGNOSTIC_CATEGORIES.has(category as SafeErrorCategory)
    ? (category as SafeErrorCategory)
    : "application_error";
}

export class PortableWorker {
  private readonly owner: string;
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelaySeconds: number;
  private readonly outboxIntervalMs: number;
  private readonly retentionMs: number;
  private readonly now: () => Date;
  private readonly wait: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly log: (
    entry: Record<string, string | number | boolean>,
  ) => void;
  private nextOutboxAt = 0;
  private nextPruneAt = 0;

  constructor(
    private readonly runtime: PortableWorkerRuntime,
    private readonly queue: PortableWorkerQueue,
    options: PortableWorkerOptions = {},
  ) {
    this.owner = options.owner ?? createId("worker");
    if (!/^[^\s@]{1,512}$/.test(this.owner)) {
      throw new Error("Worker owner must be a privacy-safe opaque ID.");
    }
    this.concurrency = options.concurrency ?? 4;
    this.leaseSeconds = options.lease_seconds ?? 60;
    this.pollIntervalMs = options.poll_interval_ms ?? 500;
    this.retryDelaySeconds = options.retry_delay_seconds ?? 30;
    this.outboxIntervalMs = options.outbox_interval_ms ?? 1_000;
    const retentionDays = options.job_retention_days ?? 7;
    validateInteger(this.concurrency, "Worker concurrency", 1, 32);
    validateInteger(this.leaseSeconds, "Worker lease duration", 5, 900);
    validateInteger(this.pollIntervalMs, "Worker poll interval", 50, 60_000);
    validateInteger(this.retryDelaySeconds, "Worker retry delay", 0, 3_600);
    validateInteger(
      this.outboxIntervalMs,
      "Worker outbox interval",
      100,
      60_000,
    );
    validateInteger(retentionDays, "Job retention days", 1, 30);
    this.retentionMs = retentionDays * 86_400_000;
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? waitFor;
    this.log =
      options.log ??
      ((entry) => {
        console.info(JSON.stringify(entry));
      });
  }

  async tick(now = this.now()): Promise<PortableWorkerTickResult> {
    if (now.getTime() >= this.nextOutboxAt) {
      try {
        await this.runtime.dispatchOutbox(now);
      } catch (error) {
        this.log({
          level: "error",
          message: "Portable outbox reconciliation failed",
          error_type: diagnosticCategory(error),
        });
      }
      this.nextOutboxAt = now.getTime() + this.outboxIntervalMs;
    }
    if (now.getTime() >= this.nextPruneAt) {
      try {
        const removed = await this.queue.pruneFinished(
          new Date(now.getTime() - this.retentionMs),
        );
        if (removed > 0) {
          this.log({
            level: "info",
            message: "Portable jobs pruned",
            removed,
          });
        }
      } catch (error) {
        this.log({
          level: "error",
          message: "Portable job pruning failed",
          error_type: diagnosticCategory(error),
        });
      }
      this.nextPruneAt = now.getTime() + 60 * 60 * 1_000;
    }

    const leaseNow = this.now();
    const leased = await this.queue.lease({
      owner: this.owner,
      lease_seconds: this.leaseSeconds,
      limit: this.concurrency,
      now: leaseNow,
    });
    const outcomes = await Promise.all(leased.map((job) => this.handle(job)));
    return {
      leased: leased.length,
      completed: outcomes.filter((value) => value === "completed").length,
      retried: outcomes.filter((value) => value === "retry_scheduled").length,
      failed: outcomes.filter((value) => value === "terminal_failure").length,
      lost: outcomes.filter((value) => value === "not_owned").length,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        let saturated = false;
        try {
          const result = await this.tick();
          saturated = result.leased === this.concurrency;
        } catch (error) {
          this.log({
            level: "error",
            message: "Portable worker cycle failed",
            error_type: diagnosticCategory(error),
          });
        }
        if (!signal.aborted && !saturated) {
          await this.wait(this.pollIntervalMs, signal);
        }
      }
    } finally {
      try {
        await this.queue.releaseOwnedLeases(this.owner, this.now());
      } catch (error) {
        this.log({
          level: "error",
          message: "Portable worker lease release failed",
          error_type: diagnosticCategory(error),
        });
      }
    }
  }

  private async handle(
    leased: PostgresLeasedJob,
  ): Promise<
    "completed" | PostgresFailureDisposition
  > {
    const heartbeat = new AbortController();
    const heartbeatRun = this.heartbeatLease(leased.id, heartbeat.signal);
    try {
      await this.runtime.processJob(leased.job, leased.attempt);
      return (await this.queue.acknowledge(
        leased.id,
        this.owner,
        this.now(),
      ))
        ? "completed"
        : "not_owned";
    } catch (error) {
      return this.queue.recordFailure(
        leased.id,
        this.owner,
        diagnosticCategory(error),
        {
          retry_delay_seconds: this.retryDelaySeconds,
          terminal: !shouldRetryOperationalError(error),
          now: this.now(),
        },
      );
    } finally {
      heartbeat.abort();
      await heartbeatRun;
    }
  }

  private async heartbeatLease(
    id: string,
    signal: AbortSignal,
  ): Promise<void> {
    const intervalMs = Math.max(1_000, Math.floor(this.leaseSeconds * 500));
    while (!signal.aborted) {
      await waitFor(intervalMs, signal);
      if (signal.aborted) {
        return;
      }
      try {
        const extended = await this.queue.extendLease(
          id,
          this.owner,
          this.leaseSeconds,
          this.now(),
        );
        if (!extended) {
          this.log({
            level: "error",
            message: "Portable worker lost a job lease",
            job_id: id,
          });
          return;
        }
      } catch (error) {
        this.log({
          level: "error",
          message: "Portable worker lease heartbeat failed",
          job_id: id,
          error_type: diagnosticCategory(error),
        });
      }
    }
  }
}

function portableWorkerOptions(config: Config): PortableWorkerOptions {
  if (
    config.mode !== "portable" ||
    config.workerConcurrency === undefined ||
    config.workerLeaseSeconds === undefined ||
    config.workerPollIntervalMs === undefined ||
    config.workerRetryDelaySeconds === undefined ||
    config.workerOutboxIntervalMs === undefined ||
    config.jobRetentionDays === undefined
  ) {
    throw new Error("Portable worker settings are incomplete.");
  }
  return {
    concurrency: config.workerConcurrency,
    lease_seconds: config.workerLeaseSeconds,
    poll_interval_ms: config.workerPollIntervalMs,
    retry_delay_seconds: config.workerRetryDelaySeconds,
    outbox_interval_ms: config.workerOutboxIntervalMs,
    job_retention_days: config.jobRetentionDays,
  };
}

async function runPortableWorkerProcess(): Promise<void> {
  const config = loadConfig();
  if (config.mode !== "portable") {
    throw new Error("The portable worker requires HAYASEND_MODE=portable.");
  }
  const pool = createPostgresPool(config, "hayasend-worker");
  const runtime: PortableRuntime = createPortableRuntime(config, pool);
  await runtime.checkReadiness();
  const worker = new PortableWorker(
    runtime,
    runtime.jobQueue,
    portableWorkerOptions(config),
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.info(
    JSON.stringify({
      level: "info",
      message: "HayaSend portable worker started",
      concurrency: config.workerConcurrency,
    }),
  );
  try {
    await worker.run(controller.signal);
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPortableWorkerProcess().catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "HayaSend portable worker failed",
        error_type: diagnosticCategory(error),
      }),
    );
    process.exitCode = 1;
  });
}
