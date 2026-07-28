import type { Pool, QueryResultRow } from "pg";
import { requestHash } from "../../core/crypto.js";
import type { SafeErrorCategory } from "../../core/error-telemetry.js";
import {
  createJobEnvelope,
  parseJobEnvelope,
  type JobEnvelope,
} from "../../core/job-envelope.js";
import type { Job } from "../../core/types.js";
import type { JobQueue } from "../../ports/job-queue.js";
import type {
  QueueDepth,
  QueueDiagnostics,
  QueueDiagnosticsSnapshot,
} from "../../ports/queue-diagnostics.js";

const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;
const MAX_BATCH_SIZE = 1_000;
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

interface JobRow extends QueryResultRow {
  id: string;
  envelope: unknown;
  attempts: number;
  lease_expires_at: Date;
}

interface CountRow extends QueryResultRow {
  visible: string;
  in_flight: string;
  delayed: string;
  total: string;
}

interface FailedCountRow extends QueryResultRow {
  job_type: Job["type"];
  total: string;
}

export interface PostgresJobQueueOptions {
  max_attempts?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface PostgresLeaseOptions {
  owner: string;
  lease_seconds: number;
  limit: number;
  now?: Date | undefined;
}

export interface PostgresLeasedJob {
  id: string;
  job: Job;
  attempt: number;
  lease_expires_at: string;
}

export type PostgresFailureDisposition =
  | "retry_scheduled"
  | "terminal_failure"
  | "not_owned";

function validateOwner(owner: string): void {
  if (!/^[^\s@]{1,512}$/.test(owner)) {
    throw new Error("Job lease owner must be a privacy-safe opaque ID.");
  }
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

function depth(
  visible: number,
  inFlight = 0,
  delayed = 0,
): QueueDepth {
  return {
    visible,
    in_flight: inFlight,
    delayed,
    total: visible + inFlight + delayed,
  };
}

function integerCount(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function envelopeFromRow(value: unknown): JobEnvelope {
  return parseJobEnvelope(typeof value === "string" ? JSON.parse(value) : value);
}

export class PostgresJobQueue implements JobQueue, QueueDiagnostics {
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: PostgresJobQueueOptions = {},
  ) {
    this.maxAttempts = options.max_attempts ?? 10;
    validateInteger(this.maxAttempts, "Job max attempts", 1, 100);
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(job: Job, delaySeconds = 0): Promise<void> {
    validateInteger(
      delaySeconds,
      "PostgreSQL queue delay",
      0,
      MAX_DELAY_SECONDS,
    );
    const now = this.now();
    const envelope = createJobEnvelope(job, now);
    const availableAt = new Date(now.getTime() + delaySeconds * 1_000);
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO jobs(
         id, job_type, envelope, available_at, lease_owner,
         lease_expires_at, attempts, max_attempts, completed_at, failed_at,
         last_diagnostic_category, created_at, updated_at
       )
       VALUES (
         $1, $2, $3::jsonb, $4, NULL,
         NULL, 0, $5, NULL, NULL,
         NULL, $6, $6
       )
       ON CONFLICT (id) DO UPDATE
       SET available_at = LEAST(jobs.available_at, EXCLUDED.available_at),
           updated_at = EXCLUDED.updated_at
       WHERE jobs.completed_at IS NULL
         AND jobs.failed_at IS NULL
         AND jobs.envelope->'job' = EXCLUDED.envelope->'job'
       RETURNING jobs.id`,
      [
        envelope.id,
        job.type,
        JSON.stringify(envelope),
        availableAt,
        this.maxAttempts,
        now,
      ],
    );
    if (inserted.rowCount !== 0) {
      return;
    }

    const existing = await this.pool.query<{ envelope: unknown }>(
      "SELECT envelope FROM jobs WHERE id = $1",
      [envelope.id],
    );
    const stored = existing.rows[0]?.envelope;
    if (
      stored !== undefined &&
      requestHash(envelopeFromRow(stored).job) !== requestHash(job)
    ) {
      throw new Error(
        "Deterministic job identity is already used by a different job.",
      );
    }
  }

  async lease(options: PostgresLeaseOptions): Promise<PostgresLeasedJob[]> {
    validateOwner(options.owner);
    validateInteger(
      options.lease_seconds,
      "Job lease duration",
      1,
      86_400,
    );
    validateInteger(options.limit, "Job lease limit", 1, MAX_BATCH_SIZE);
    const now = options.now ?? this.now();
    const result = await this.pool.query<JobRow>(
      `WITH candidates AS (
         SELECT id
         FROM jobs
         WHERE completed_at IS NULL
           AND failed_at IS NULL
           AND available_at <= $1
           AND (lease_owner IS NULL OR lease_expires_at <= $1)
         ORDER BY available_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs
       SET lease_owner = $3,
           lease_expires_at =
             $1::timestamptz + ($4::double precision * interval '1 second'),
           attempts = attempts + 1,
           updated_at = $1
       FROM candidates
       WHERE jobs.id = candidates.id
       RETURNING
         jobs.id,
         jobs.envelope,
         jobs.attempts,
         jobs.lease_expires_at`,
      [now, options.limit, options.owner, options.lease_seconds],
    );
    return result.rows.map((row) => ({
      id: row.id,
      job: envelopeFromRow(row.envelope).job,
      attempt: row.attempts,
      lease_expires_at: row.lease_expires_at.toISOString(),
    }));
  }

  async acknowledge(
    id: string,
    owner: string,
    now = this.now(),
  ): Promise<boolean> {
    validateOwner(owner);
    const result = await this.pool.query(
      `UPDATE jobs
       SET completed_at = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = $3
       WHERE id = $1
         AND lease_owner = $2
         AND completed_at IS NULL
         AND failed_at IS NULL`,
      [id, owner, now],
    );
    return result.rowCount === 1;
  }

  async extendLease(
    id: string,
    owner: string,
    leaseSeconds: number,
    now = this.now(),
  ): Promise<boolean> {
    validateOwner(owner);
    validateInteger(leaseSeconds, "Job lease duration", 1, 86_400);
    const result = await this.pool.query(
      `UPDATE jobs
       SET lease_expires_at =
             $3::timestamptz +
             ($4::double precision * interval '1 second'),
           updated_at = $3
       WHERE id = $1
         AND lease_owner = $2
         AND completed_at IS NULL
         AND failed_at IS NULL`,
      [id, owner, now, leaseSeconds],
    );
    return result.rowCount === 1;
  }

  async recordFailure(
    id: string,
    owner: string,
    category: SafeErrorCategory,
    options: {
      retry_delay_seconds: number;
      terminal?: boolean | undefined;
      now?: Date | undefined;
    },
  ): Promise<PostgresFailureDisposition> {
    validateOwner(owner);
    if (!SAFE_DIAGNOSTIC_CATEGORIES.has(category)) {
      throw new Error("Job diagnostic category is not privacy-safe.");
    }
    validateInteger(
      options.retry_delay_seconds,
      "Job retry delay",
      0,
      MAX_DELAY_SECONDS,
    );
    const now = options.now ?? this.now();
    const result = await this.pool.query<{ failed_at: Date | null }>(
      `UPDATE jobs
       SET failed_at =
             CASE
               WHEN $5::boolean OR attempts >= max_attempts
                 THEN $3::timestamptz
               ELSE NULL
             END,
           available_at =
             CASE
               WHEN $5::boolean OR attempts >= max_attempts THEN available_at
               ELSE
                 $3::timestamptz +
                 ($4::double precision * interval '1 second')
             END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_diagnostic_category = $6,
           updated_at = $3
       WHERE id = $1
         AND lease_owner = $2
         AND completed_at IS NULL
         AND failed_at IS NULL
       RETURNING failed_at`,
      [
        id,
        owner,
        now,
        options.retry_delay_seconds,
        options.terminal === true,
        category,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      return "not_owned";
    }
    return row.failed_at
      ? "terminal_failure"
      : "retry_scheduled";
  }

  async releaseOwnedLeases(owner: string, now = this.now()): Promise<number> {
    validateOwner(owner);
    const result = await this.pool.query(
      `UPDATE jobs
       SET lease_owner = NULL,
           lease_expires_at = NULL,
           available_at = LEAST(available_at, $2),
           updated_at = $2
       WHERE lease_owner = $1
         AND completed_at IS NULL
         AND failed_at IS NULL`,
      [owner, now],
    );
    return result.rowCount ?? 0;
  }

  async recoverFailed(id: string, now = this.now()): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE jobs
       SET available_at = $2,
           lease_owner = NULL,
           lease_expires_at = NULL,
           attempts = 0,
           failed_at = NULL,
           last_diagnostic_category = NULL,
           updated_at = $2
       WHERE id = $1
         AND completed_at IS NULL
         AND failed_at IS NOT NULL`,
      [id, now],
    );
    return result.rowCount === 1;
  }

  async pruneFinished(before: Date, limit = MAX_BATCH_SIZE): Promise<number> {
    validateInteger(limit, "Job prune limit", 1, MAX_BATCH_SIZE);
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT id
         FROM jobs
         WHERE COALESCE(completed_at, failed_at) < $1
         ORDER BY COALESCE(completed_at, failed_at), id
         LIMIT $2
       )
       DELETE FROM jobs
       USING candidates
       WHERE jobs.id = candidates.id`,
      [before, limit],
    );
    return result.rowCount ?? 0;
  }

  async getQueueDiagnostics(
    now = this.now(),
  ): Promise<QueueDiagnosticsSnapshot> {
    const [primaryResult, failedResult] = await Promise.all([
      this.pool.query<CountRow>(
        `SELECT
           count(*) FILTER (
             WHERE available_at <= $1
               AND (lease_owner IS NULL OR lease_expires_at <= $1)
           )::text AS visible,
           count(*) FILTER (
             WHERE lease_owner IS NOT NULL AND lease_expires_at > $1
           )::text AS in_flight,
           count(*) FILTER (WHERE available_at > $1)::text AS delayed,
           count(*)::text AS total
         FROM jobs
         WHERE completed_at IS NULL AND failed_at IS NULL`,
        [now],
      ),
      this.pool.query<FailedCountRow>(
        `SELECT job_type, count(*)::text AS total
         FROM jobs
         WHERE failed_at IS NOT NULL
         GROUP BY job_type`,
      ),
    ]);
    const primary = primaryResult.rows[0];
    const failedByType = new Map(
      failedResult.rows.map((row) => [
        row.job_type,
        integerCount(row.total),
      ]),
    );
    const delivery =
      (failedByType.get("send_email") ?? 0) +
      (failedByType.get("deliver_webhook") ?? 0);
    const scheduler = failedByType.get("reconcile_outbox") ?? 0;
    const inbound = failedByType.get("publish_received_email") ?? 0;
    return {
      provider: "postgresql",
      primary: {
        visible: integerCount(primary?.visible),
        in_flight: integerCount(primary?.in_flight),
        delayed: integerCount(primary?.delayed),
        total: integerCount(primary?.total),
      },
      dead_letters: {
        delivery: depth(delivery),
        scheduler: depth(scheduler),
        inbound: depth(inbound),
      },
    };
  }
}
