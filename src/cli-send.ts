import {
  readBoundedFile,
  readLocalAttachments,
  uploadLocalAttachments,
} from "./cli-send-attachments.js";
import { parseTemplateVariables } from "./cli-templates.js";
import { parseScheduledAt } from "./core/schedule.js";
import { sendEmailSchema } from "./schemas.js";

const MAX_REQUEST_BYTES = 9 * 1024 * 1024;
const MAX_HEADER_BYTES = 998;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TAG_NAME = /^[A-Za-z0-9_-]{1,256}$/;
const RESERVED_HEADERS = new Set([
  "bcc",
  "cc",
  "content-transfer-encoding",
  "content-type",
  "from",
  "mime-version",
  "reply-to",
  "subject",
  "to",
]);

interface ParsedSendOptions {
  singles: Map<string, string>;
  multiples: Map<string, string[]>;
}

export interface SendCommandContext {
  baseUrl: string;
  cwd: string;
  fetch: typeof fetch;
  log(message: string): void;
  readStdin(maximumBytes: number): Promise<Uint8Array>;
  request(path: string, init?: RequestInit): Promise<unknown>;
}

const SINGLE_OPTIONS = new Set([
  "endpoint",
  "from",
  "html",
  "html-file",
  "idempotency-key",
  "scheduled-at",
  "subject",
  "template",
  "text",
  "text-file",
]);
const MULTIPLE_OPTIONS = new Set([
  "attachment",
  "bcc",
  "cc",
  "header",
  "reply-to",
  "tag",
  "to",
  "var",
]);

function parseOptions(args: string[]): ParsedSendOptions {
  const singles = new Map<string, string>();
  const multiples = new Map<string, string[]>();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (!option?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${option ?? ""}`);
    }
    const name = option.slice(2);
    if (SINGLE_OPTIONS.has(name)) {
      if (singles.has(name)) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${name} requires a value.`);
      }
      singles.set(name, value);
      index += 1;
      continue;
    }
    if (!MULTIPLE_OPTIONS.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    const values = multiples.get(name) ?? [];
    let consumed = 0;
    while (
      args[index + consumed + 1] !== undefined &&
      !args[index + consumed + 1]?.startsWith("--")
    ) {
      values.push(args[index + consumed + 1] ?? "");
      consumed += 1;
    }
    if (consumed === 0) {
      throw new Error(`--${name} requires at least one value.`);
    }
    multiples.set(name, values);
    index += consumed;
  }
  return { singles, multiples };
}

function values(options: ParsedSendOptions, name: string) {
  return options.multiples.get(name) ?? [];
}

function validateHeaderValue(label: string, value: string) {
  if (value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be non-empty and contain no line breaks.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_HEADER_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_HEADER_BYTES} bytes.`);
  }
}

function splitPair(value: string, option: string) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `--${option} values must use NAME=VALUE with a non-empty value.`,
    );
  }
  return [value.slice(0, separator), value.slice(separator + 1)] as const;
}

function parseHeaders(inputs: string[]) {
  if (inputs.length === 0) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  for (const input of inputs) {
    const [name, value] = splitPair(input, "header");
    const normalized = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      Buffer.byteLength(name, "utf8") > MAX_HEADER_BYTES
    ) {
      throw new Error(`Header name ${name} is invalid.`);
    }
    if (RESERVED_HEADERS.has(normalized)) {
      throw new Error(`Header ${name} is managed by HayaSend.`);
    }
    if (names.has(normalized)) {
      throw new Error(`Header ${name} was provided more than once.`);
    }
    validateHeaderValue(`Header ${name}`, value);
    names.add(normalized);
    headers[name] = value;
  }
  return headers;
}

function parseTags(inputs: string[]) {
  if (inputs.length === 0) {
    return undefined;
  }
  if (inputs.length > 49) {
    throw new Error("At most 49 --tag values may be provided.");
  }
  const names = new Set<string>();
  return inputs.map((input) => {
    const [name, value] = splitPair(input, "tag");
    if (!TAG_NAME.test(name)) {
      throw new Error(
        `Tag name ${name} must contain 1–256 ASCII letters, numbers, underscores, or hyphens.`,
      );
    }
    if (Buffer.byteLength(value, "utf8") > 256) {
      throw new Error(`Tag ${name} must not exceed 256 bytes.`);
    }
    if (names.has(name)) {
      throw new Error(`Tag ${name} was provided more than once.`);
    }
    names.add(name);
    return { name, value };
  });
}

function decodeUtf8(content: Uint8Array, label: string) {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`${label} must contain valid UTF-8.`);
  }
  if (decoded.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return decoded;
}

async function readBody(
  options: ParsedSendOptions,
  name: "html" | "text",
  context: SendCommandContext,
  stdin: { content?: Uint8Array },
) {
  const inline = options.singles.get(name);
  const file = options.singles.get(`${name}-file`);
  if (inline !== undefined && file !== undefined) {
    throw new Error(`--${name} and --${name}-file cannot be combined.`);
  }
  if (inline !== undefined) {
    if (inline.length === 0) {
      throw new Error(`--${name} must not be empty.`);
    }
    return inline;
  }
  if (file === undefined) {
    return undefined;
  }
  const content =
    file === "-"
      ? (stdin.content ??= await context.readStdin(MAX_REQUEST_BYTES))
      : await readBoundedFile(context.cwd, file, MAX_REQUEST_BYTES);
  return decodeUtf8(content, `--${name}-file`);
}

function formatSchemaError(
  issues: Array<{ path: PropertyKey[]; message: string }>,
) {
  return issues
    .map(({ path, message }) =>
      path.length > 0 ? `${path.join(".")}: ${message}` : message,
    )
    .join("; ");
}

function ensureSerializedRequest(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("The serialized email request must not exceed 9 MiB.");
  }
}

function idFromResponse(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^email_[a-f0-9]{32}$/.test(value.id)
  ) {
    throw new Error("HayaSend did not return a valid email identifier.");
  }
  return value.id;
}

function httpStatus(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
  ) {
    return error.status;
  }
  return undefined;
}

export async function readStandardInput(maximumBytes: number) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk);
    length += bytes.byteLength;
    if (length > maximumBytes) {
      throw new Error(`stdin exceeds the ${maximumBytes}-byte limit.`);
    }
    chunks.push(bytes);
  }
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

export async function sendEmail(
  args: string[],
  context: SendCommandContext,
) {
  const options = parseOptions(args);
  const template = options.singles.get("template");
  const textFile = options.singles.get("text-file");
  const htmlFile = options.singles.get("html-file");
  if (textFile === "-" && htmlFile === "-") {
    throw new Error("stdin may be used for only one email body.");
  }
  const hasBody =
    options.singles.has("text") ||
    textFile !== undefined ||
    options.singles.has("html") ||
    htmlFile !== undefined;
  if (template && hasBody) {
    throw new Error(
      "--template cannot be combined with HTML or text body options.",
    );
  }
  const variableInputs = values(options, "var");
  if (!template && variableInputs.length > 0) {
    throw new Error("--var requires --template.");
  }
  if (!template && !hasBody) {
    throw new Error(
      "Direct sends require at least one HTML or text body option.",
    );
  }
  const recipients = [
    ...values(options, "to"),
    ...values(options, "cc"),
    ...values(options, "bcc"),
  ];
  if (recipients.length === 0 || recipients.length > 50) {
    throw new Error("A send requires between 1 and 50 recipients.");
  }
  if (!template) {
    if (!options.singles.get("from") || !options.singles.get("subject")) {
      throw new Error(
        "Direct sends require --from, --subject, and a message body.",
      );
    }
  }
  for (const [label, value] of [
    ["--from", options.singles.get("from")],
    ["--subject", options.singles.get("subject")],
    ...recipients.map(
      (recipient) => ["Recipient", recipient] as const,
    ),
    ...values(options, "reply-to").map(
      (replyTo) => ["--reply-to", replyTo] as const,
    ),
  ] as const) {
    if (value !== undefined) {
      validateHeaderValue(label, value);
    }
  }
  const variables = template
    ? parseTemplateVariables(variableInputs)
    : undefined;
  const scheduledAt = parseScheduledAt(
    options.singles.get("scheduled-at"),
  );
  const headers = parseHeaders(values(options, "header"));
  const tags = parseTags(values(options, "tag"));
  const idempotencyKey = options.singles.get("idempotency-key");
  if (idempotencyKey !== undefined) {
    validateHeaderValue("--idempotency-key", idempotencyKey);
    if (idempotencyKey.length > 256) {
      throw new Error("--idempotency-key must not exceed 256 characters.");
    }
  }

  const stdin: { content?: Uint8Array } = {};
  const [text, html, attachments] = await Promise.all([
    readBody(options, "text", context, stdin),
    readBody(options, "html", context, stdin),
    readLocalAttachments(values(options, "attachment"), context.cwd),
  ]);
  const candidate = {
    ...(options.singles.get("from")
      ? { from: options.singles.get("from") }
      : {}),
    to: values(options, "to"),
    ...(options.singles.get("subject")
      ? { subject: options.singles.get("subject") }
      : {}),
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(template
      ? {
          template: {
            id: template,
            variables,
          },
        }
      : {}),
    ...(values(options, "cc").length > 0
      ? { cc: values(options, "cc") }
      : {}),
    ...(values(options, "bcc").length > 0
      ? { bcc: values(options, "bcc") }
      : {}),
    ...(values(options, "reply-to").length > 0
      ? { reply_to: values(options, "reply-to") }
      : {}),
    ...(headers ? { headers } : {}),
    ...(tags ? { tags } : {}),
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
  };
  const parsed = sendEmailSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Invalid send options: ${formatSchemaError(parsed.error.issues)}`,
    );
  }
  ensureSerializedRequest(parsed.data);

  const attachmentIds = await uploadLocalAttachments(
    attachments,
    context,
  );
  const payload = {
    ...parsed.data,
    ...(attachmentIds.length > 0
      ? {
          attachments: attachmentIds.map((attachmentId) => ({
            attachment_id: attachmentId,
          })),
        }
      : {}),
  };
  const validatedPayload = sendEmailSchema.safeParse(payload);
  if (!validatedPayload.success) {
    throw new Error(
      `Invalid send payload: ${formatSchemaError(
        validatedPayload.error.issues,
      )}`,
    );
  }
  ensureSerializedRequest(validatedPayload.data);

  let response: unknown;
  try {
    response = await context.request("/emails", {
      method: "POST",
      ...(idempotencyKey
        ? { headers: { "idempotency-key": idempotencyKey } }
        : {}),
      body: JSON.stringify(validatedPayload.data),
    });
  } catch (error) {
    const status = httpStatus(error);
    if (status !== undefined) {
      throw new Error(`Email creation failed with HTTP ${status}.`);
    }
    throw error;
  }
  const id = idFromResponse(response);
  context.log(JSON.stringify({ id }, null, 2));
}
