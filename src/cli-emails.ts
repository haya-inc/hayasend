import { parseScheduledAt } from "./core/schedule.js";

interface EmailCommandContext {
  log(message: string): void;
  request(path: string, init?: RequestInit): Promise<unknown>;
}

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

interface EmailRecordShape extends Record<string, unknown> {
  id: string;
  status: string;
  last_event: string;
  created_at: string;
  updated_at: string;
  to: unknown[];
}

const EMAIL_ID_PATTERN = /^email_[a-f0-9]{32}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const SAFE_ERROR_PATTERN =
  /^Email delivery failed \([a-z][a-z0-9_]{0,63}\)\.$/;
const EMAIL_STATUSES = new Set([
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "delivery_delayed",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  "canceled",
  "suppressed",
]);
const EMAIL_EVENTS = new Set([...EMAIL_STATUSES, "retrying"]);

function parseOptions(
  args: string[],
  specification: {
    values?: string[];
    booleans?: string[];
    positionals?: number;
  },
): ParsedOptions {
  const allowedValues = new Set(specification.values ?? []);
  const allowedBooleans = new Set(specification.booleans ?? []);
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) {
      positionals.push(argument ?? "");
      continue;
    }
    const name = argument.slice(2);
    if (allowedBooleans.has(name)) {
      if (booleans.has(name)) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      booleans.add(name);
      continue;
    }
    if (!allowedValues.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (values.has(name)) {
      throw new Error(`Option --${name} may be provided only once.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }

  const expectedPositionals = specification.positionals ?? 0;
  if (positionals.length < expectedPositionals) {
    throw new Error("Email ID is required.");
  }
  if (positionals.length > expectedPositionals) {
    throw new Error(`Unexpected argument: ${positionals[expectedPositionals]}`);
  }
  return { positionals, values, booleans };
}

function nonEmptyString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("HayaSend returned an invalid email record.");
  }
  return value;
}

function optionalArray(
  record: Record<string, unknown>,
  field: string,
): unknown[] {
  const value = record[field];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  return value;
}

function emailIdentifier(value: string, label = "Email ID") {
  if (!EMAIL_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid HayaSend email ID.`);
  }
  return value;
}

function lifecycleValue(
  record: Record<string, unknown>,
  field: string,
  allowed: Set<string>,
) {
  const value = nonEmptyString(record, field);
  if (!allowed.has(value)) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  return value;
}

function timestamp(
  record: Record<string, unknown>,
  field: string,
  optional = false,
) {
  const value = optional
    ? optionalString(record, field)
    : nonEmptyString(record, field);
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  return value;
}

function emailRecord(value: unknown): EmailRecordShape {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  const record = value as Record<string, unknown>;
  const to = record.to;
  if (!Array.isArray(to)) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  return {
    ...record,
    id: emailIdentifier(nonEmptyString(record, "id"), "Response email ID"),
    status: lifecycleValue(record, "status", EMAIL_STATUSES),
    last_event: lifecycleValue(record, "last_event", EMAIL_EVENTS),
    created_at: timestamp(record, "created_at") ?? "",
    updated_at: timestamp(record, "updated_at") ?? "",
    to,
  };
}

function emailSummary(value: unknown) {
  const record = emailRecord(value);
  const cc = optionalArray(record, "cc");
  const bcc = optionalArray(record, "bcc");
  const attachments = optionalArray(record, "attachments");
  const html = optionalString(record, "html");
  const plainText = optionalString(record, "text");
  const scheduledAt = timestamp(record, "scheduled_at", true);
  const providerId = optionalString(record, "provider_id");
  const error = optionalString(record, "error");
  if (providerId && !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  if (error && !SAFE_ERROR_PATTERN.test(error)) {
    throw new Error("HayaSend returned an invalid email record.");
  }
  return {
    object: "email_summary",
    id: record.id,
    status: record.status,
    last_event: record.last_event,
    created_at: record.created_at,
    updated_at: record.updated_at,
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    ...(providerId ? { provider_id: providerId } : {}),
    ...(error ? { error } : {}),
    recipient_count: record.to.length + cc.length + bcc.length,
    attachment_count: attachments.length,
    has_content: Boolean(html?.length || plainText?.length),
  };
}

function emailList(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HayaSend returned an invalid email list.");
  }
  const response = value as Record<string, unknown>;
  if (response.object !== "list" || !Array.isArray(response.data)) {
    throw new Error("HayaSend returned an invalid email list.");
  }
  if (typeof response.has_more !== "boolean") {
    throw new Error("HayaSend returned an invalid email list.");
  }
  if (
    response.next_cursor !== undefined &&
    typeof response.next_cursor !== "string"
  ) {
    throw new Error("HayaSend returned an invalid email list.");
  }
  return {
    object: "list",
    data: response.data.map(emailSummary),
    has_more: response.has_more,
    ...(typeof response.next_cursor === "string"
      ? {
          next_cursor: emailIdentifier(
            response.next_cursor,
            "Response pagination cursor",
          ),
        }
      : {}),
  };
}

function limit(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("--limit must be an integer from 1 to 100.");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 100) {
    throw new Error("--limit must be an integer from 1 to 100.");
  }
  return String(parsed);
}

function requireConfirmation(options: ParsedOptions, operation: string) {
  if (!options.booleans.has("yes")) {
    throw new Error(
      `${operation} requires --yes because it changes an existing email.`,
    );
  }
}

function emailPath(id: string) {
  return `/emails/${encodeURIComponent(emailIdentifier(id))}`;
}

function mutationResult(value: unknown, expectedId: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HayaSend returned an invalid email mutation result.");
  }
  const id = emailIdentifier(
    nonEmptyString(value as Record<string, unknown>, "id"),
    "Response email ID",
  );
  if (id !== expectedId) {
    throw new Error("HayaSend returned an unexpected email ID.");
  }
  return { id };
}

function print(value: unknown, context: EmailCommandContext) {
  context.log(JSON.stringify(value, null, 2));
}

export async function emailCommand(
  args: string[],
  context: EmailCommandContext,
) {
  const command = args[0] ?? "help";
  switch (command) {
    case "list": {
      const options = parseOptions(args, {
        values: ["limit", "after", "endpoint"],
      });
      const parameters = new URLSearchParams();
      const boundedLimit = limit(options.values.get("limit"));
      if (boundedLimit) {
        parameters.set("limit", boundedLimit);
      }
      const after = options.values.get("after");
      if (after) {
        parameters.set("after", emailIdentifier(after, "Pagination cursor"));
      }
      const query = parameters.size > 0 ? `?${parameters}` : "";
      print(emailList(await context.request(`/emails${query}`)), context);
      break;
    }
    case "get": {
      const options = parseOptions(args, {
        values: ["endpoint"],
        booleans: ["include-content"],
        positionals: 1,
      });
      const response = await context.request(
        emailPath(options.positionals[0] ?? ""),
      );
      print(
        options.booleans.has("include-content")
          ? emailRecord(response)
          : emailSummary(response),
        context,
      );
      break;
    }
    case "cancel": {
      const options = parseOptions(args, {
        values: ["endpoint"],
        booleans: ["yes"],
        positionals: 1,
      });
      requireConfirmation(options, "Email cancellation");
      const id = emailIdentifier(options.positionals[0] ?? "");
      print(
        mutationResult(
          await context.request(emailPath(id) + "/cancel", {
            method: "POST",
          }),
          id,
        ),
        context,
      );
      break;
    }
    case "update": {
      const options = parseOptions(args, {
        values: ["scheduled-at", "endpoint"],
        booleans: ["yes"],
        positionals: 1,
      });
      requireConfirmation(options, "Email rescheduling");
      const scheduledAt = options.values.get("scheduled-at");
      if (!scheduledAt) {
        throw new Error("--scheduled-at is required.");
      }
      const parsed = parseScheduledAt(scheduledAt);
      const id = emailIdentifier(options.positionals[0] ?? "");
      print(
        mutationResult(
          await context.request(emailPath(id), {
            method: "PATCH",
            body: JSON.stringify({ scheduled_at: parsed }),
          }),
          id,
        ),
        context,
      );
      break;
    }
    default:
      throw new Error(
        `Unknown emails command: ${command}. Run hayasend help.`,
      );
  }
}
