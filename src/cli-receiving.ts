import {
  downloadToFile,
  prepareDownloadOutput,
  type DownloadContext,
} from "./cli-download.js";

interface ReceivingCommandContext extends DownloadContext {
  cwd: string;
  log(message: string): void;
  request(path: string, init?: RequestInit): Promise<unknown>;
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

function receivedSummary(value: unknown) {
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

function receivedList(value: unknown) {
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

function receivedPath(id: string) {
  return `/emails/receiving/${encodeURIComponent(id)}`;
}

function print(value: unknown, context: ReceivingCommandContext) {
  context.log(JSON.stringify(value, null, 2));
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
