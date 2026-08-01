const DAY_MS = 86_400_000;
const IDEMPOTENCY_RETRY_WINDOW_MS = DAY_MS;

export const DOGFOOD_DAYS = 14;
export const DOGFOOD_SLOTS_PER_DAY = 4;
export const DOGFOOD_BATCH_SIZE = 18;
export const DOGFOOD_EXPECTED_TOTAL =
  DOGFOOD_DAYS * DOGFOOD_SLOTS_PER_DAY * DOGFOOD_BATCH_SIZE;

export const DOGFOOD_NOTIFICATION_TYPES = [
  {
    key: "pdf.completed",
    label: "PDF completed",
    text: "A synthetic PDF export completed. No customer or private content is present.",
  },
  {
    key: "pdf.failed",
    label: "PDF failed",
    text: "A synthetic PDF export failed and can be retried. No customer or private content is present.",
  },
  {
    key: "sharing.created",
    label: "Sharing created",
    text: "A synthetic document was shared. No customer or private content is present.",
  },
  {
    key: "operations.quota_warning",
    label: "Quota warning",
    text: "A synthetic quota warning requires operator attention. No customer or private content is present.",
  },
];

function utcDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} must be a real UTC calendar date.`);
  }
  return parsed;
}

export function planDogfoodRun({
  startDate,
  runDate,
  slot,
  batchSize = DOGFOOD_BATCH_SIZE,
}) {
  const start = utcDate(startDate, "startDate");
  const run = utcDate(runDate, "runDate");
  if (!Number.isInteger(slot) || slot < 0 || slot >= DOGFOOD_SLOTS_PER_DAY) {
    throw new Error("slot must be an integer from 0 through 3.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("batchSize must be an integer from 1 through 100.");
  }
  const dayIndex = Math.round((run.getTime() - start.getTime()) / DAY_MS);
  const active = dayIndex >= 0 && dayIndex < DOGFOOD_DAYS;
  return {
    object: "aws_dogfood_plan",
    start_date: startDate,
    end_date: new Date(start.getTime() + (DOGFOOD_DAYS - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10),
    run_date: runDate,
    day_index: dayIndex,
    day_number: active ? dayIndex + 1 : null,
    slot,
    active,
    batch_size: batchSize,
    expected_total: DOGFOOD_EXPECTED_TOTAL,
    global_offset: active
      ? dayIndex * DOGFOOD_SLOTS_PER_DAY * DOGFOOD_BATCH_SIZE +
        slot * DOGFOOD_BATCH_SIZE
      : null,
  };
}

export function buildDogfoodMessage(plan, index, from, to) {
  if (!plan.active || plan.global_offset === null) {
    throw new Error(
      "Cannot build a message outside the active campaign window.",
    );
  }
  if (!Number.isInteger(index) || index < 0 || index >= plan.batch_size) {
    throw new Error("Message index is outside the planned batch.");
  }
  const ordinal = plan.global_offset + index;
  const notification =
    DOGFOOD_NOTIFICATION_TYPES[ordinal % DOGFOOD_NOTIFICATION_TYPES.length];
  const localOrdinal = String(index + 1).padStart(2, "0");
  return {
    notification_type: notification.key,
    idempotency_key: `hayasend-dogfood-v1-${plan.run_date}-s${plan.slot}-${localOrdinal}`,
    payload: {
      from,
      to,
      subject:
        `[HayaSend Dogfood] ${notification.label} ` +
        `${plan.run_date} s${plan.slot} #${localOrdinal}`,
      text:
        `${notification.text}\n\n` +
        `Campaign date: ${plan.run_date}\n` +
        `Slot: ${plan.slot}\n` +
        `Sequence: ${localOrdinal}\n`,
    },
  };
}

export function requireDogfoodRetryWindow(plan, now = new Date()) {
  if (!plan.active) {
    throw new Error("The campaign slot is outside the active window.");
  }
  const slotHour = String(plan.slot * 6).padStart(2, "0");
  const scheduledAt = new Date(`${plan.run_date}T${slotHour}:17:00.000Z`);
  const ageMs = now.getTime() - scheduledAt.getTime();
  if (ageMs < 0) {
    throw new Error(
      "The campaign slot cannot run before its nominal UTC time.",
    );
  }
  if (ageMs >= IDEMPOTENCY_RETRY_WINDOW_MS) {
    throw new Error(
      "The campaign slot is outside HayaSend's 24-hour idempotency retry window.",
    );
  }
  return {
    scheduled_at: scheduledAt.toISOString(),
    age_ms: ageMs,
  };
}

export function durationSummary(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("At least one duration is required.");
  }
  const sorted = values
    .map((value) => {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("Durations must be finite non-negative numbers.");
      }
      return Math.round(value);
    })
    .sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.ceil(ratio * sorted.length) - 1];
  return {
    count: sorted.length,
    min_ms: sorted[0],
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: sorted.at(-1),
  };
}
