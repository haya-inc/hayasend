import { ValidationError } from "./errors.js";

const RELATIVE_SCHEDULE =
  /^in\s+(\d+)\s*(minute|minutes|min|hour|hours|day|days)$/i;

export function parseScheduledAt(
  value: string | undefined,
  now = new Date(),
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const relative = RELATIVE_SCHEDULE.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]?.toLowerCase();
    const multiplier = unit?.startsWith("min")
      ? 60_000
      : unit?.startsWith("hour")
        ? 3_600_000
        : 86_400_000;
    return new Date(now.getTime() + amount * multiplier).toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(
      "scheduled_at must be an ISO 8601 timestamp or a value such as 'in 10 minutes'.",
    );
  }
  if (parsed.getTime() <= now.getTime()) {
    throw new ValidationError("scheduled_at must be in the future.");
  }
  if (parsed.getTime() > now.getTime() + 30 * 86_400_000) {
    throw new ValidationError(
      "scheduled_at must be no more than 30 days in the future.",
    );
  }
  return parsed.toISOString();
}

export function delaySecondsUntil(
  scheduledAt: string | undefined,
  now = new Date(),
): number {
  if (!scheduledAt) {
    return 0;
  }
  const seconds = Math.ceil(
    (new Date(scheduledAt).getTime() - now.getTime()) / 1_000,
  );
  return Math.max(0, Math.min(900, seconds));
}
