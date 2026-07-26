import {
  downloadToFile,
  prepareDownloadOutput,
  type DownloadContext,
} from "./cli-download.js";

interface ReceivingCommandContext extends DownloadContext {
  cwd: string;
  error(message: string): void;
  log(message: string): void;
  request(path: string, init?: RequestInit): Promise<unknown>;
  sleep(milliseconds: number): Promise<void>;
}

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

interface ReceivedEmailShape {
  id: string;
  createdAt: string;
  to: string[];
  receivedFor: string[];
  bcc: string[];
  cc: string[];
  attachments: AttachmentMetadata[];
  contentTruncated: boolean;
  source: Record<string, unknown>;
}

interface ReceivedEmailSummary {
  object: "received_email_summary";
  id: string;
  created_at: string;
  recipient_count: number;
  envelope_recipient_count: number;
  attachment_count: number;
  content_truncated: boolean;
}

interface ReceivedEmailPage {
  object: "list";
  data: ReceivedEmailSummary[];
  has_more: boolean;
  next_cursor?: string;
}

interface DownloadTarget {
  downloadUrl: string;
  expiresAt: string;
}

interface AttachmentShape extends DownloadTarget {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  contentDisposition: "inline" | "attachment" | null;
  contentId: string | null;
}

type AttachmentMetadata = Omit<
  AttachmentShape,
  "downloadUrl" | "expiresAt"
>;

function parseOptions(
  args: string[],
  specification: {
    values?: string[];
    booleans?: string[];
    positionals?: string[];
  },
): ParsedOptions {
  const allowedValues = new Set(specification.values ?? []);
  const allowedBooleans = new Set(specification.booleans ?? []);
  const labels = specification.positionals ?? [];
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
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }
  if (positionals.length < labels.length) {
    throw new Error(`${labels[positionals.length] ?? "Argument"} is required.`);
  }
  if (positionals.length > labels.length) {
    throw new Error(`Unexpected argument: ${positionals[labels.length]}`);
  }
  return { booleans, positionals, values };
}

function objectRecord(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`HayaSend returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(
  record: Record<string, unknown>,
  field: string,
  label: string,
) {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`HayaSend returned an invalid ${label}.`);
  }
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  field: string,
  label: string,
) {
  const value = record[field];
  if (value !== null && typeof value !== "string") {
    throw new Error(`HayaSend returned an invalid ${label}.`);
  }
  return value;
}

function stringArray(
  record: Record<string, unknown>,
  field: string,
  label: string,
) {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`HayaSend returned an invalid ${label}.`);
  }
  return value as string[];
}

function receivedEmail(value: unknown): ReceivedEmailShape {
  const record = objectRecord(value, "received email record");
  const id = stringValue(record, "id", "received email record");
  const createdAt = stringValue(
    record,
    "created_at",
    "received email record",
  );
  if (
    record.object !== "email" ||
    !/^recv_[a-f0-9]{32}$/.test(id) ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof record.from !== "string" ||
    typeof record.subject !== "string" ||
    typeof record.message_id !== "string" ||
    !Array.isArray(record.attachments) ||
    (record.content_truncated !== undefined &&
      typeof record.content_truncated !== "boolean")
  ) {
    throw new Error("HayaSend returned an invalid received email record.");
  }
  return {
    id,
    createdAt,
    to: stringArray(record, "to", "received email record"),
    receivedFor: stringArray(
      record,
      "received_for",
      "received email record",
    ),
    bcc: stringArray(record, "bcc", "received email record"),
    cc: stringArray(record, "cc", "received email record"),
    attachments: record.attachments.map(attachmentMetadata),
    contentTruncated: record.content_truncated === true,
    source: record,
  };
}

function receivedSummary(value: unknown): ReceivedEmailSummary {
  const record = receivedEmail(value);
  return {
    object: "received_email_summary",
    id: record.id,
    created_at: record.createdAt,
    recipient_count:
      record.to.length + record.cc.length + record.bcc.length,
    envelope_recipient_count: record.receivedFor.length,
    attachment_count: record.attachments.length,
    content_truncated: record.contentTruncated,
  };
}

function receivedList(value: unknown): ReceivedEmailPage {
  const response = objectRecord(value, "received email list");
  if (
    response.object !== "list" ||
    !Array.isArray(response.data) ||
    typeof response.has_more !== "boolean" ||
    (response.next_cursor !== undefined &&
      typeof response.next_cursor !== "string")
  ) {
    throw new Error("HayaSend returned an invalid received email list.");
  }
  return {
    object: "list",
    data: response.data.map(receivedSummary),
    has_more: response.has_more,
    ...(typeof response.next_cursor === "string"
      ? { next_cursor: response.next_cursor }
      : {}),
  };
}

function downloadTarget(value: unknown): DownloadTarget {
  const target = objectRecord(value, "download target");
  const downloadUrl = stringValue(target, "download_url", "download target");
  const expiresAt = stringValue(target, "expires_at", "download target");
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry) || expiry <= Date.now()) {
    throw new Error("HayaSend returned an expired download target.");
  }
  return { downloadUrl, expiresAt };
}

function attachmentMetadata(value: unknown): AttachmentMetadata {
  const record = objectRecord(value, "received attachment");
  const id = stringValue(record, "id", "received attachment");
  const filename = stringValue(record, "filename", "received attachment");
  const size = record.size;
  const disposition = record.content_disposition;
  const contentId = nullableString(
    record,
    "content_id",
    "received attachment",
  );
  if (
    !/^att_[a-f0-9]{32}$/.test(id) ||
    filename.length > 255 ||
    /[\u0000-\u001F\u007F]/.test(filename) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    !["inline", "attachment", null].includes(
      disposition as "inline" | "attachment" | null,
    )
  ) {
    throw new Error("HayaSend returned an invalid received attachment.");
  }
  const contentType = stringValue(
    record,
    "content_type",
    "received attachment",
  );
  if (
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
      contentType,
    )
  ) {
    throw new Error("HayaSend returned an invalid received attachment.");
  }
  return {
    id,
    filename,
    size: size as number,
    contentType,
    contentDisposition: disposition as "inline" | "attachment" | null,
    contentId,
  };
}

function attachment(value: unknown): AttachmentShape {
  return {
    ...attachmentMetadata(value),
    ...downloadTarget(value),
  };
}

function publicAttachment(record: AttachmentMetadata) {
  return {
    id: record.id,
    filename: record.filename,
    size: record.size,
    content_type: record.contentType,
    content_disposition: record.contentDisposition,
    content_id: record.contentId,
  };
}

function attachmentSummary(value: unknown) {
  const record = attachment(value);
  return {
    object: "attachment_summary",
    id: record.id,
    filename: record.filename,
    size: record.size,
    content_type: record.contentType,
    content_disposition: record.contentDisposition,
    has_content_id: record.contentId !== null,
  };
}

function attachmentList(value: unknown) {
  const response = objectRecord(value, "received attachment list");
  if (
    response.object !== "list" ||
    !Array.isArray(response.data) ||
    response.has_more !== false
  ) {
    throw new Error("HayaSend returned an invalid received attachment list.");
  }
  return {
    object: "list",
    data: response.data.map(attachmentSummary),
    has_more: false,
  };
}

function fullReceivedEmail(value: unknown) {
  const parsed = receivedEmail(value);
  const record = parsed.source;
  const html = nullableString(record, "html", "received email record");
  const text = nullableString(record, "text", "received email record");
  const htmlFormat = stringValue(
    record,
    "html_format",
    "received email record",
  );
  const headers = objectRecord(record.headers, "received email headers");
  if (
    !["data_uri", "cid"].includes(htmlFormat) ||
    Object.values(headers).some((entry) => typeof entry !== "string")
  ) {
    throw new Error("HayaSend returned an invalid received email record.");
  }
  const raw = downloadTarget(record.raw);
  return {
    object: "email",
    id: parsed.id,
    from: record.from,
    to: parsed.to,
    received_for: parsed.receivedFor,
    bcc: parsed.bcc,
    cc: parsed.cc,
    reply_to: stringArray(record, "reply_to", "received email record"),
    subject: record.subject,
    message_id: record.message_id,
    attachments: parsed.attachments.map(publicAttachment),
    created_at: parsed.createdAt,
    ...(parsed.contentTruncated ? { content_truncated: true } : {}),
    html,
    html_format: htmlFormat,
    text,
    headers,
    raw: {
      download_url: raw.downloadUrl,
      expires_at: raw.expiresAt,
    },
  };
}

function boundedLimit(value: string | undefined) {
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

function boundedInteger(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(
      `--${option} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(
      `--${option} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function receivedPath(id: string) {
  return `/emails/receiving/${encodeURIComponent(id)}`;
}

function print(value: unknown, context: ReceivingCommandContext) {
  context.log(JSON.stringify(value, null, 2));
}

const LISTEN_PAGE_SIZE = 100;
const LISTEN_PAGES_PER_POLL = 5;
const LISTEN_SEEN_LIMIT = 5_000;
const LISTEN_BACKLOG_LIMIT = 5_000;

interface ListenState {
  cursor?: string;
  pending: ReceivedEmailSummary[];
}

interface ListenFetchResult {
  state: ListenState;
  complete: boolean;
  failed: boolean;
}

class ListenFatalError extends Error {}

function receivedListPath(limit: number, after?: string) {
  const parameters = new URLSearchParams({ limit: String(limit) });
  if (after) {
    parameters.set("after", after);
  }
  return `/emails/receiving?${parameters}`;
}

async function getReceivedPage(
  limit: number,
  after: string | undefined,
  context: ReceivingCommandContext,
) {
  return receivedList(
    await context.request(receivedListPath(limit, after)),
  );
}

function rememberSeen(seenIds: Set<string>, id: string) {
  seenIds.delete(id);
  seenIds.add(id);
  while (seenIds.size > LISTEN_SEEN_LIMIT) {
    const oldest = seenIds.values().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    seenIds.delete(oldest);
  }
}

function appendUnseen(
  pending: ReceivedEmailSummary[],
  candidates: ReceivedEmailSummary[],
  seenIds: Set<string>,
) {
  const pendingIds = new Set(pending.map((email) => email.id));
  for (const email of candidates) {
    if (!seenIds.has(email.id) && !pendingIds.has(email.id)) {
      pending.push(email);
      pendingIds.add(email.id);
      if (pending.length > LISTEN_BACKLOG_LIMIT) {
        throw new ListenFatalError(
          `Receiving listen backlog exceeds ${LISTEN_BACKLOG_LIMIT} messages; stop and drain the list explicitly.`,
        );
      }
    }
  }
}

async function fetchListenPages(
  initial: ListenState,
  seenIds: Set<string>,
  context: ReceivingCommandContext,
): Promise<ListenFetchResult> {
  const pending = [...initial.pending];
  let cursor = initial.cursor;
  for (
    let pageNumber = 0;
    pageNumber < LISTEN_PAGES_PER_POLL;
    pageNumber += 1
  ) {
    let page: ReceivedEmailPage;
    try {
      page = await getReceivedPage(
        LISTEN_PAGE_SIZE,
        cursor,
        context,
      );
    } catch {
      return {
        state: cursor ? { cursor, pending } : { pending },
        complete: false,
        failed: true,
      };
    }
    const seenIndex = page.data.findIndex((email) =>
      seenIds.has(email.id),
    );
    appendUnseen(
      pending,
      seenIndex >= 0 ? page.data.slice(0, seenIndex) : page.data,
      seenIds,
    );
    if (seenIndex >= 0 || !page.has_more) {
      return {
        state: { pending },
        complete: true,
        failed: false,
      };
    }
    if (!page.next_cursor || page.next_cursor === cursor) {
      throw new ListenFatalError(
        "HayaSend returned an invalid receiving pagination cursor.",
      );
    }
    cursor = page.next_cursor;
  }
  return {
    state: cursor ? { cursor, pending } : { pending },
    complete: false,
    failed: false,
  };
}

function listenWarning(
  code: "page_cap_reached" | "poll_failed",
  context: ReceivingCommandContext,
  details: Record<string, number>,
) {
  context.error(
    JSON.stringify({
      object: "listen_warning",
      code,
      ...details,
    }),
  );
}

async function listen(
  options: ParsedOptions,
  context: ReceivingCommandContext,
) {
  const interval = options.values.has("interval")
    ? boundedInteger(
        options.values.get("interval"),
        "interval",
        2,
        3_600,
      )
    : 5;
  const maxPolls = options.values.has("max-polls")
    ? boundedInteger(
        options.values.get("max-polls"),
        "max-polls",
        1,
        1_000_000,
      )
    : undefined;
  const seenIds = new Set<string>();
  let seed: ReceivedEmailPage;
  try {
    seed = await getReceivedPage(1, undefined, context);
  } catch {
    throw new Error("Receiving listen could not connect to HayaSend.");
  }
  for (const email of seed.data.toReversed()) {
    rememberSeen(seenIds, email.id);
  }

  let state: ListenState = { pending: [] };
  let consecutiveFailures = 0;
  let polls = 0;
  while (maxPolls === undefined || polls < maxPolls) {
    await context.sleep(interval * 1_000);
    polls += 1;
    const result = await fetchListenPages(state, seenIds, context);
    state = result.state;
    if (result.failed) {
      consecutiveFailures += 1;
      listenWarning("poll_failed", context, {
        consecutive_failures: consecutiveFailures,
      });
      if (consecutiveFailures >= 5) {
        throw new ListenFatalError(
          "Receiving listen stopped after 5 consecutive API failures.",
        );
      }
      continue;
    }
    consecutiveFailures = 0;
    if (!result.complete) {
      listenWarning("page_cap_reached", context, {
        pending_count: state.pending.length,
      });
      continue;
    }
    for (const email of state.pending.toReversed()) {
      rememberSeen(seenIds, email.id);
      context.log(JSON.stringify(email));
    }
    state = { pending: [] };
  }
  if (state.pending.length > 0 || state.cursor) {
    throw new Error(
      "Receiving listen stopped before the pending backlog was complete.",
    );
  }
  if (consecutiveFailures > 0) {
    throw new Error("Receiving listen ended after an API failure.");
  }
}

async function download(
  kind: "attachment" | "raw_email",
  target: DownloadTarget,
  output: Awaited<ReturnType<typeof prepareDownloadOutput>>,
  context: ReceivingCommandContext,
  expectedBytes?: number,
  minimumBytes = 0,
) {
  const result = await downloadToFile(
    target.downloadUrl,
    output,
    context,
    expectedBytes,
    minimumBytes,
  );
  print({ object: "download", kind, ...result }, context);
}

export async function receivingCommand(
  args: string[],
  context: ReceivingCommandContext,
) {
  const command = args[0] ?? "help";
  switch (command) {
    case "list": {
      const options = parseOptions(args, {
        values: ["limit", "after", "endpoint"],
      });
      const parameters = new URLSearchParams();
      const limit = boundedLimit(options.values.get("limit"));
      if (limit) {
        parameters.set("limit", limit);
      }
      const after = options.values.get("after");
      if (after) {
        parameters.set("after", after);
      }
      const query = parameters.size > 0 ? `?${parameters}` : "";
      print(
        receivedList(
          await context.request(`/emails/receiving${query}`),
        ),
        context,
      );
      break;
    }
    case "listen": {
      const options = parseOptions(args, {
        values: ["interval", "max-polls", "endpoint"],
      });
      await listen(options, context);
      break;
    }
    case "get": {
      const options = parseOptions(args, {
        values: ["html-format", "endpoint"],
        booleans: ["include-content"],
        positionals: ["Received email ID"],
      });
      const includeContent = options.booleans.has("include-content");
      const htmlFormat = options.values.get("html-format");
      if (htmlFormat && !includeContent) {
        throw new Error("--html-format requires --include-content.");
      }
      if (htmlFormat && !["data-uri", "cid"].includes(htmlFormat)) {
        throw new Error("--html-format must be data-uri or cid.");
      }
      const apiFormat =
        htmlFormat === "data-uri"
          ? "data_uri"
          : htmlFormat === "cid"
            ? "cid"
            : includeContent
              ? undefined
              : "cid";
      const query = apiFormat ? `?html_format=${apiFormat}` : "";
      const response = await context.request(
        `${receivedPath(options.positionals[0] ?? "")}${query}`,
      );
      print(
        includeContent
          ? fullReceivedEmail(response)
          : receivedSummary(response),
        context,
      );
      break;
    }
    case "attachments": {
      const options = parseOptions(args, {
        values: ["endpoint"],
        positionals: ["Received email ID"],
      });
      print(
        attachmentList(
          await context.request(
            `${receivedPath(options.positionals[0] ?? "")}/attachments`,
          ),
        ),
        context,
      );
      break;
    }
    case "attachment": {
      const options = parseOptions(args, {
        values: ["output", "endpoint"],
        booleans: ["force"],
        positionals: ["Received email ID", "Attachment ID"],
      });
      const configuredOutput = options.values.get("output");
      if (!configuredOutput) {
        throw new Error("--output is required.");
      }
      const output = await prepareDownloadOutput(
        context.cwd,
        configuredOutput,
        options.booleans.has("force"),
      );
      const emailId = options.positionals[0] ?? "";
      const attachmentId = options.positionals[1] ?? "";
      const response = attachment(
        await context.request(
          `${receivedPath(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
        ),
      );
      if (response.id !== attachmentId) {
        throw new Error(
          "HayaSend returned a different received attachment identifier.",
        );
      }
      await download("attachment", response, output, context, response.size);
      break;
    }
    case "raw": {
      const options = parseOptions(args, {
        values: ["output", "endpoint"],
        booleans: ["force"],
        positionals: ["Received email ID"],
      });
      const configuredOutput = options.values.get("output");
      if (!configuredOutput) {
        throw new Error("--output is required.");
      }
      const output = await prepareDownloadOutput(
        context.cwd,
        configuredOutput,
        options.booleans.has("force"),
      );
      const response = fullReceivedEmail(
        await context.request(
          `${receivedPath(options.positionals[0] ?? "")}?html_format=cid`,
        ),
      );
      const target = downloadTarget(response.raw);
      await download("raw_email", target, output, context, undefined, 1);
      break;
    }
    default:
      throw new Error(
        `Unknown emails receiving command: ${command}. Run hayasend help.`,
      );
  }
}
