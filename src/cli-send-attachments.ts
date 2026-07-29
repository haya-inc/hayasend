import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const UPLOAD_TIMEOUT_MS = 60_000;
const CONTENT_TYPES = new Map([
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".ics", "text/calendar"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xml", "application/xml"],
  [".zip", "application/zip"],
]);

interface LocalAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  checksum: string;
}

interface AttachmentUpload {
  id: string;
  url: string;
  headers: Headers;
}

export interface AttachmentUploadContext {
  baseUrl: string;
  fetch: typeof fetch;
  allowedUploadOrigins?: ReadonlySet<string>;
  request(path: string, init?: RequestInit): Promise<unknown>;
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

export async function readBoundedFile(
  cwd: string,
  configuredPath: string,
  maximumBytes: number,
) {
  // This is an intentional local-CLI file selector: the operator supplies the
  // path, and the descriptor is restricted to a resolved, no-follow, regular
  // file with a caller-defined byte limit.
  const path = await realpath(resolve(cwd, configuredPath)); // lgtm[js/path-injection]
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new Error(`Expected a regular file: ${configuredPath}`);
    }
    if (metadata.size > maximumBytes) {
      throw new Error(
        `File exceeds the ${maximumBytes}-byte limit: ${configuredPath}`,
      );
    }
    const content = await file.readFile();
    if (content.byteLength > maximumBytes) {
      throw new Error(
        `File exceeds the ${maximumBytes}-byte limit: ${configuredPath}`,
      );
    }
    return new Uint8Array(content);
  } finally {
    await file.close();
  }
}

function contentType(filename: string) {
  return (
    CONTENT_TYPES.get(extname(filename).toLowerCase()) ??
    "application/octet-stream"
  );
}

export async function readLocalAttachments(
  paths: string[],
  cwd: string,
) {
  if (paths.length > MAX_ATTACHMENTS) {
    throw new Error(`At most ${MAX_ATTACHMENTS} attachments may be provided.`);
  }
  const attachments: LocalAttachment[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    if (path === "-") {
      throw new Error(
        "--attachment does not accept stdin because a filename is required.",
      );
    }
    const filename = basename(path);
    if (
      filename.length === 0 ||
      filename === "." ||
      Buffer.byteLength(filename, "utf8") > 255
    ) {
      throw new Error(`Attachment filename is invalid: ${path}`);
    }
    const content = await readBoundedFile(cwd, path, MAX_ATTACHMENT_BYTES);
    if (content.byteLength === 0) {
      throw new Error(`Attachment must not be empty: ${path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error("Decoded attachment content must not exceed 25 MiB.");
    }
    attachments.push({
      filename,
      contentType: contentType(filename),
      content,
      checksum: createHash("sha256").update(content).digest("hex"),
    });
  }
  return attachments;
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function isAwsS3Hostname(hostname: string) {
  const suffix = hostname.endsWith(".amazonaws.com.cn")
    ? ".amazonaws.com.cn"
    : hostname.endsWith(".amazonaws.com")
      ? ".amazonaws.com"
      : "";
  if (!suffix) {
    return false;
  }
  return hostname
    .slice(0, -suffix.length)
    .split(".")
    .some((label) => label === "s3" || label.startsWith("s3-"));
}

function isGoogleCloudStorageHostname(hostname: string) {
  return (
    hostname === "storage.googleapis.com" ||
    hostname.endsWith(".storage.googleapis.com")
  );
}

function isAzureBlobHostname(hostname: string) {
  return [
    ".blob.core.windows.net",
    ".blob.core.chinacloudapi.cn",
    ".blob.core.usgovcloudapi.net",
    ".blob.core.cloudapi.de",
  ].some(
    (suffix) =>
      hostname.endsWith(suffix) &&
      hostname.length > suffix.length,
  );
}

function isVercelBlobHostname(hostname: string) {
  const suffix = ".blob.vercel-storage.com";
  return (
    hostname.endsWith(suffix) &&
    hostname.length > suffix.length
  );
}

function isBuiltInObjectStorageHostname(hostname: string) {
  return (
    isAwsS3Hostname(hostname) ||
    isGoogleCloudStorageHostname(hostname) ||
    isAzureBlobHostname(hostname) ||
    isVercelBlobHostname(hostname)
  );
}

export function parseAttachmentUploadOrigins(value: string | undefined) {
  const origins = new Set<string>();
  if (!value) {
    return origins;
  }
  const entries = value.split(",");
  if (entries.length > 20) {
    throw new Error(
      "HAYASEND_ATTACHMENT_UPLOAD_ORIGINS accepts at most 20 origins.",
    );
  }
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry.trim());
    } catch {
      throw new Error(
        "HAYASEND_ATTACHMENT_UPLOAD_ORIGINS must contain comma-separated absolute origins.",
      );
    }
    const loopback = isLoopback(url.hostname);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && !loopback) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    ) {
      throw new Error(
        "HAYASEND_ATTACHMENT_UPLOAD_ORIGINS must contain HTTPS origins (HTTP is allowed only for loopback emulators).",
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

function safeUploadUrl(
  value: unknown,
  baseUrl: string,
  allowedUploadOrigins: ReadonlySet<string> = new Set(),
) {
  if (typeof value !== "string") {
    throw new Error("HayaSend returned an invalid attachment upload URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HayaSend returned an invalid attachment upload URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !isLoopback(url.hostname)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("HayaSend returned an unsafe attachment upload URL.");
  }
  const api = new URL(baseUrl);
  const loopbackUpload =
    isLoopback(api.hostname) &&
    isLoopback(url.hostname) &&
    api.protocol === url.protocol &&
    api.port === url.port;
  if (
    url.origin !== api.origin &&
    !loopbackUpload &&
    (url.protocol !== "https:" ||
      (!isBuiltInObjectStorageHostname(url.hostname) &&
        !allowedUploadOrigins.has(url.origin)))
  ) {
    throw new Error(
      "HayaSend returned an attachment upload URL outside its API origin or trusted object-storage origins.",
    );
  }
  return url.toString();
}

function uploadHeaders(
  value: unknown,
  expectedContentType: string,
  checksum: string,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HayaSend returned invalid attachment upload headers.");
  }
  const headers = new Headers();
  const allowedHeaders = new Set([
    "content-type",
    "if-none-match",
    "x-amz-checksum-sha256",
    "x-amz-meta-hayasend-sha256",
    "x-amz-server-side-encryption",
    "x-goog-meta-hayasend-sha256",
    "x-ms-blob-type",
    "x-ms-meta-hayasend_sha256",
  ]);
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      typeof headerValue !== "string" ||
      /[\r\n]/.test(name) ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new Error("HayaSend returned invalid attachment upload headers.");
    }
    if (!allowedHeaders.has(name.toLowerCase())) {
      throw new Error(
        `HayaSend returned a forbidden attachment upload header: ${name}.`,
      );
    }
    headers.set(name, headerValue);
  }
  if (headers.get("content-type") !== expectedContentType) {
    throw new Error(
      "HayaSend returned an unexpected attachment content type.",
    );
  }
  const checksumHeader = headers.get("x-amz-checksum-sha256");
  if (
    checksumHeader !== null &&
    checksumHeader !== Buffer.from(checksum, "hex").toString("base64")
  ) {
    throw new Error(
      "HayaSend returned an unexpected attachment checksum header.",
    );
  }
  for (const name of [
    "x-amz-meta-hayasend-sha256",
    "x-goog-meta-hayasend-sha256",
    "x-ms-meta-hayasend_sha256",
  ]) {
    const value = headers.get(name);
    if (value !== null && value !== checksum) {
      throw new Error(
        "HayaSend returned an unexpected attachment checksum header.",
      );
    }
  }
  const blobType = headers.get("x-ms-blob-type");
  if (blobType !== null && blobType !== "BlockBlob") {
    throw new Error(
      "HayaSend returned an unexpected Azure Blob upload type.",
    );
  }
  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch !== null && ifNoneMatch !== "*") {
    throw new Error(
      "HayaSend returned an unsafe conditional upload header.",
    );
  }
  const encryption = headers.get("x-amz-server-side-encryption");
  if (encryption !== null && encryption !== "AES256") {
    throw new Error(
      "HayaSend returned an unsupported object-storage encryption header.",
    );
  }
  return headers;
}

function parseUpload(
  value: unknown,
  attachment: LocalAttachment,
  context: AttachmentUploadContext,
): AttachmentUpload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HayaSend returned an invalid attachment upload.");
  }
  const upload = value as Record<string, unknown>;
  if (
    typeof upload.id !== "string" ||
    !/^att_[a-f0-9]{32}$/.test(upload.id) ||
    upload.filename !== attachment.filename ||
    upload.content_type !== attachment.contentType ||
    upload.size_bytes !== attachment.content.byteLength ||
    upload.checksum_sha256 !== attachment.checksum ||
    upload.upload_method !== "PUT"
  ) {
    throw new Error("HayaSend returned an invalid attachment upload.");
  }
  return {
    id: upload.id,
    url: safeUploadUrl(
      upload.upload_url,
      context.baseUrl,
      context.allowedUploadOrigins,
    ),
    headers: uploadHeaders(
      upload.upload_headers,
      attachment.contentType,
      attachment.checksum,
    ),
  };
}

async function uploadAttachment(
  attachment: LocalAttachment,
  context: AttachmentUploadContext,
) {
  let declaration: unknown;
  try {
    declaration = await context.request("/attachments", {
      method: "POST",
      body: JSON.stringify({
        filename: attachment.filename,
        content_type: attachment.contentType,
        size_bytes: attachment.content.byteLength,
        checksum_sha256: attachment.checksum,
      }),
    });
  } catch (error) {
    const status = httpStatus(error);
    if (status !== undefined) {
      throw new Error(`Attachment declaration failed with HTTP ${status}.`);
    }
    throw error;
  }
  const upload = parseUpload(
    declaration,
    attachment,
    context,
  );
  const uploadBody = new Uint8Array(attachment.content.byteLength);
  uploadBody.set(attachment.content);
  const response = await context.fetch(upload.url, {
    method: "PUT",
    headers: upload.headers,
    body: uploadBody,
    redirect: "error",
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Attachment upload failed with HTTP ${response.status}.`);
  }
  return upload.id;
}

export async function uploadLocalAttachments(
  attachments: LocalAttachment[],
  context: AttachmentUploadContext,
) {
  const identifiers: string[] = [];
  for (const attachment of attachments) {
    identifiers.push(await uploadAttachment(attachment, context));
  }
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("HayaSend returned duplicate attachment identifiers.");
  }
  return identifiers;
}
