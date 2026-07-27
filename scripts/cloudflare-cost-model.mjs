#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PRICING_LAST_VERIFIED = "2026-07-27";

export const PRICING_SOURCES = {
  workers:
    "https://developers.cloudflare.com/workers/platform/pricing/",
  d1: "https://developers.cloudflare.com/d1/platform/pricing/",
  r2: "https://developers.cloudflare.com/r2/pricing/",
  queues:
    "https://developers.cloudflare.com/queues/platform/pricing/",
  email:
    "https://developers.cloudflare.com/email-service/platform/pricing/",
};

export const PAID_RATES = {
  workers_subscription_month: 5,
  workers_requests_included: 10_000_000,
  workers_requests_per_million: 0.3,
  workers_cpu_ms_included: 30_000_000,
  workers_cpu_ms_per_million: 0.02,
  d1_rows_read_included: 25_000_000_000,
  d1_rows_read_per_million: 0.001,
  d1_rows_written_included: 50_000_000,
  d1_rows_written_per_million: 1,
  d1_storage_gb_month_included: 5,
  d1_storage_gb_month: 0.75,
  r2_storage_gb_month_included: 10,
  r2_storage_gb_month: 0.015,
  r2_class_a_included: 1_000_000,
  r2_class_a_per_million: 4.5,
  r2_class_b_included: 10_000_000,
  r2_class_b_per_million: 0.36,
  queue_operations_included: 1_000_000,
  queue_operations_per_million: 0.4,
  email_messages_included: 3_000,
  email_messages_per_thousand: 0.35,
};

export const WORKLOAD_PROFILES = {
  proof: {
    messages: 10,
    provider_events_per_message: 1,
  },
  dogfood: {
    messages: 1_000,
    provider_events_per_message: 1,
  },
  representative: {
    messages: 1_000_000,
    provider_events_per_message: 2,
  },
};

const DEFAULT_OBSERVED = {
  average_worker_cpu_ms: 8,
  worker_requests_per_message: 3,
  d1_rows_read_per_message: 40,
  d1_rows_written_per_message: 35,
  d1_metadata_kib_per_message: 8,
  r2_payload_kib_per_message: 32,
  r2_class_a_per_message: 1,
  r2_class_b_per_message: 1,
  queue_messages_per_email: 2,
  queue_operations_per_message: 3,
  retention_days: 30,
};

function requireFinite(name, value, minimum) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum
  ) {
    throw new Error(`${name} must be at least ${minimum}.`);
  }
  return value;
}

function round(value, digits = 6) {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function metered(quantity, included, unitSize, unitRate) {
  const billable = Math.max(0, quantity - included);
  return {
    quantity: round(quantity),
    included,
    billable_quantity: round(billable),
    unit_size: unitSize,
    unit_rate_usd: unitRate,
    monthly_usd: round((billable / unitSize) * unitRate),
  };
}

export function estimateCloudflareCosts({
  profile = "dogfood",
  observed = {},
} = {}) {
  const workload = WORKLOAD_PROFILES[profile];
  if (!workload) {
    throw new Error(
      `profile must be one of ${Object.keys(WORKLOAD_PROFILES).join(", ")}.`,
    );
  }
  const assumptions = {
    ...DEFAULT_OBSERVED,
    ...workload,
    ...observed,
  };
  for (const [name, value] of Object.entries(assumptions)) {
    requireFinite(name, value, name === "messages" ? 1 : 0);
  }
  if (!Number.isInteger(assumptions.messages)) {
    throw new Error("messages must be an integer.");
  }

  const events =
    assumptions.messages * assumptions.provider_events_per_message;
  const workerRequests =
    assumptions.messages * assumptions.worker_requests_per_message +
    events;
  const workerCpuMs =
    workerRequests * assumptions.average_worker_cpu_ms;
  const d1RowsRead =
    assumptions.messages * assumptions.d1_rows_read_per_message +
    events * 10;
  const d1RowsWritten =
    assumptions.messages * assumptions.d1_rows_written_per_message +
    events * 8;
  const retainedMonthFraction = assumptions.retention_days / 30;
  const d1StorageGbMonth =
    (assumptions.messages *
      assumptions.d1_metadata_kib_per_message *
      retainedMonthFraction) /
    (1024 * 1024);
  const r2StorageGbMonth =
    (assumptions.messages *
      assumptions.r2_payload_kib_per_message *
      retainedMonthFraction) /
    (1024 * 1024);
  const r2ClassA =
    assumptions.messages * assumptions.r2_class_a_per_message;
  const r2ClassB =
    assumptions.messages * assumptions.r2_class_b_per_message;
  const queueOperations =
    (assumptions.messages * assumptions.queue_messages_per_email +
      events) *
    assumptions.queue_operations_per_message;

  const components = {
    workers_subscription: {
      quantity: 1,
      included: 0,
      billable_quantity: 1,
      unit_size: 1,
      unit_rate_usd: PAID_RATES.workers_subscription_month,
      monthly_usd: PAID_RATES.workers_subscription_month,
    },
    workers_requests: metered(
      workerRequests,
      PAID_RATES.workers_requests_included,
      1_000_000,
      PAID_RATES.workers_requests_per_million,
    ),
    workers_cpu_ms: metered(
      workerCpuMs,
      PAID_RATES.workers_cpu_ms_included,
      1_000_000,
      PAID_RATES.workers_cpu_ms_per_million,
    ),
    d1_rows_read: metered(
      d1RowsRead,
      PAID_RATES.d1_rows_read_included,
      1_000_000,
      PAID_RATES.d1_rows_read_per_million,
    ),
    d1_rows_written: metered(
      d1RowsWritten,
      PAID_RATES.d1_rows_written_included,
      1_000_000,
      PAID_RATES.d1_rows_written_per_million,
    ),
    d1_storage_gb_month: metered(
      d1StorageGbMonth,
      PAID_RATES.d1_storage_gb_month_included,
      1,
      PAID_RATES.d1_storage_gb_month,
    ),
    r2_storage_gb_month: metered(
      r2StorageGbMonth,
      PAID_RATES.r2_storage_gb_month_included,
      1,
      PAID_RATES.r2_storage_gb_month,
    ),
    r2_class_a: metered(
      r2ClassA,
      PAID_RATES.r2_class_a_included,
      1_000_000,
      PAID_RATES.r2_class_a_per_million,
    ),
    r2_class_b: metered(
      r2ClassB,
      PAID_RATES.r2_class_b_included,
      1_000_000,
      PAID_RATES.r2_class_b_per_million,
    ),
    queue_operations: metered(
      queueOperations,
      PAID_RATES.queue_operations_included,
      1_000_000,
      PAID_RATES.queue_operations_per_million,
    ),
    email_messages: metered(
      assumptions.messages,
      PAID_RATES.email_messages_included,
      1_000,
      PAID_RATES.email_messages_per_thousand,
    ),
  };
  return {
    schema_version: "1.0.0",
    object: "cloudflare_cost_estimate",
    pricing_last_verified: PRICING_LAST_VERIFIED,
    pricing_sources: PRICING_SOURCES,
    provider_maturity: "beta",
    profile,
    observed_inputs: assumptions,
    calculated_usage: {
      provider_events: events,
      worker_requests: workerRequests,
      worker_cpu_ms: workerCpuMs,
      d1_rows_read: d1RowsRead,
      d1_rows_written: d1RowsWritten,
      d1_storage_gb_month: round(d1StorageGbMonth),
      r2_storage_gb_month: round(r2StorageGbMonth),
      r2_class_a: r2ClassA,
      r2_class_b: r2ClassB,
      queue_operations: queueOperations,
      email_messages: assumptions.messages,
    },
    components,
    monthly_usd: round(
      Object.values(components).reduce(
        (total, component) => total + component.monthly_usd,
        0,
      ),
    ),
    caveats: [
      "Email Sending requires Workers Paid and remains Beta.",
      "New-account daily sending limits are adaptive and are not a purchasable fixed quota.",
      "Replace every observed_* input with hosted analytics before making a production decision.",
      "Cloudflare account-wide included usage may already be consumed by unrelated workloads.",
    ],
  };
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArgument(name) {
  const value = argument(name);
  return value === undefined ? undefined : Number(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const observed = Object.fromEntries(
    [
      "messages",
      "provider_events_per_message",
      "average_worker_cpu_ms",
      "worker_requests_per_message",
      "d1_rows_read_per_message",
      "d1_rows_written_per_message",
      "d1_metadata_kib_per_message",
      "r2_payload_kib_per_message",
      "r2_class_a_per_message",
      "r2_class_b_per_message",
      "queue_messages_per_email",
      "queue_operations_per_message",
      "retention_days",
    ]
      .map((name) => [name, numberArgument(name)])
      .filter(([, value]) => value !== undefined),
  );
  console.log(
    JSON.stringify(
      estimateCloudflareCosts({
        profile: argument("profile") ?? "dogfood",
        observed,
      }),
      null,
      2,
    ),
  );
}
