import { AppError } from "./errors.js";

export type SafeErrorCategory =
  | "application_error"
  | "invalid_data"
  | "network_dns"
  | "network_refused"
  | "network_reset"
  | "provider_error"
  | "provider_rejected"
  | "provider_throttled"
  | "provider_unavailable"
  | "timeout";

export type SafeFailureAction =
  | "Email delivery failed"
  | "Inbound email processing failed"
  | "SES event processing failed"
  | "Webhook delivery failed"
  | "Webhook enqueue failed";

const NETWORK_ERROR_CATEGORIES = new Map<string, SafeErrorCategory>([
  ["ECONNREFUSED", "network_refused"],
  ["ECONNRESET", "network_reset"],
  ["ENETUNREACH", "network_refused"],
  ["ENOTFOUND", "network_dns"],
  ["EAI_AGAIN", "network_dns"],
  ["ETIMEDOUT", "timeout"],
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function networkCategory(
  error: unknown,
  remainingDepth = 2,
): SafeErrorCategory | undefined {
  const candidate = record(error);
  if (!candidate) {
    return undefined;
  }
  const code =
    typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  const category = NETWORK_ERROR_CATEGORIES.get(code);
  if (category) {
    return category;
  }
  return remainingDepth > 0
    ? networkCategory(candidate.cause, remainingDepth - 1)
    : undefined;
}

function providerCategory(error: unknown): SafeErrorCategory | undefined {
  const metadata = record(record(error)?.$metadata);
  if (!metadata) {
    return undefined;
  }
  const status =
    typeof metadata.httpStatusCode === "number"
      ? metadata.httpStatusCode
      : undefined;
  if (status === 429) {
    return "provider_throttled";
  }
  if (status !== undefined && status >= 500) {
    return "provider_unavailable";
  }
  if (status !== undefined && status >= 400) {
    return "provider_rejected";
  }
  return "provider_error";
}

function classifyError(error: unknown): SafeErrorCategory | string {
  if (
    error instanceof AppError &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.name)
  ) {
    return error.name;
  }
  const network = networkCategory(error);
  if (network) {
    return network;
  }
  const provider = providerCategory(error);
  if (provider) {
    return provider;
  }
  if (
    error instanceof SyntaxError ||
    record(error)?.name === "SyntaxError"
  ) {
    return "invalid_data";
  }
  const name = record(error)?.name;
  if (
    typeof name === "string" &&
    ["AbortError", "TimeoutError"].includes(name)
  ) {
    return "timeout";
  }
  return "application_error";
}

export function safeErrorCategory(error: unknown): SafeErrorCategory | string {
  try {
    return classifyError(error);
  } catch {
    return "application_error";
  }
}

export function safeFailureMessage(
  action: SafeFailureAction,
  error: unknown,
): string {
  return `${action} (${safeErrorCategory(error)}).`;
}

export function safeRuntimeError(
  action: SafeFailureAction,
  error: unknown,
): Error {
  const sanitized = new Error(safeFailureMessage(action, error));
  sanitized.name = "HayaSendOperationalError";
  return sanitized;
}
