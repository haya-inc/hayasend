import { safeErrorCategory } from "../core/error-telemetry.js";
import type {
  DeliveryDiagnosticCategory,
  OutboxItemRecord,
} from "../core/delivery-model.js";
import type { JobQueue } from "../ports/job-queue.js";
import type {
  DeliveryOutboxStore,
  OutboxMetrics,
} from "../ports/delivery-outbox-store.js";

export interface OutboxSweepResult {
  leased: number;
  dispatched: number;
  failed: number;
}

export interface OutboxReconcilerOptions {
  owner: string;
  lease_seconds?: number | undefined;
  batch_size?: number | undefined;
  after_publish?:
    | ((item: OutboxItemRecord) => void | Promise<void>)
    | undefined;
}

export interface OutboxRunOptions {
  interval_ms?: number | undefined;
  now?: (() => Date) | undefined;
  wait?:
    | ((milliseconds: number, signal: AbortSignal) => Promise<void>)
    | undefined;
}

const DIAGNOSTIC_CATEGORIES = new Set<DeliveryDiagnosticCategory>([
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

function diagnosticCategory(error: unknown): DeliveryDiagnosticCategory {
  const category = safeErrorCategory(error);
  return DIAGNOSTIC_CATEGORIES.has(category as DeliveryDiagnosticCategory)
    ? (category as DeliveryDiagnosticCategory)
    : "application_error";
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

export class OutboxReconciler {
  private readonly leaseSeconds: number;
  private readonly batchSize: number;

  constructor(
    private readonly store: DeliveryOutboxStore,
    private readonly queue: JobQueue,
    private readonly options: OutboxReconcilerOptions,
  ) {
    if (!/^[^\s@]{1,512}$/.test(options.owner)) {
      throw new Error("Outbox lease owner must be a privacy-safe opaque ID.");
    }
    this.leaseSeconds = options.lease_seconds ?? 60;
    this.batchSize = options.batch_size ?? 100;
    if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds <= 0) {
      throw new Error("Outbox lease duration must be a positive integer.");
    }
    if (
      !Number.isInteger(this.batchSize) ||
      this.batchSize <= 0 ||
      this.batchSize > 1_000
    ) {
      throw new Error("Outbox batch size must be between 1 and 1000.");
    }
  }

  async sweep(now = new Date()): Promise<OutboxSweepResult> {
    const leased = await this.store.leaseDueOutbox({
      owner: this.options.owner,
      now,
      lease_seconds: this.leaseSeconds,
      limit: this.batchSize,
    });
    let dispatched = 0;
    let failed = 0;

    for (const item of leased) {
      try {
        await this.queue.enqueue({
          type: "send_email",
          email_id: item.message_id,
          job_id: item.id,
        });
      } catch (error) {
        failed += 1;
        await this.store.recordOutboxFailure(
          item.id,
          this.options.owner,
          diagnosticCategory(error),
          now,
        );
        continue;
      }

      // This hook models process loss after queue acceptance. It deliberately
      // runs outside the queue-failure catch so the lease remains recoverable.
      await this.options.after_publish?.(structuredClone(item));

      if (
        await this.store.acknowledgeOutbox(
          item.id,
          this.options.owner,
          now,
        )
      ) {
        dispatched += 1;
      }
    }
    return { leased: leased.length, dispatched, failed };
  }

  async metrics(now = new Date()): Promise<OutboxMetrics> {
    return this.store.getOutboxMetrics(now);
  }

  async run(
    signal: AbortSignal,
    options: OutboxRunOptions = {},
  ): Promise<void> {
    const interval = options.interval_ms ?? 1_000;
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new Error("Outbox sweep interval must be a positive integer.");
    }
    const now = options.now ?? (() => new Date());
    const wait = options.wait ?? waitFor;
    while (!signal.aborted) {
      await this.sweep(now());
      if (!signal.aborted) {
        await wait(interval, signal);
      }
    }
  }
}
