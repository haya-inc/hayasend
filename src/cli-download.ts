import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

class DownloadLimitError extends Error {}

export interface DownloadContext {
  baseUrl: string;
  fetch: typeof fetch;
}

export interface PreparedDownloadOutput {
  force: boolean;
  path: string;
  directory: string;
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
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

export function safeDownloadUrl(value: unknown, baseUrl: string) {
  if (typeof value !== "string") {
    throw new Error("HayaSend returned an invalid download target.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HayaSend returned an invalid download target.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !isLoopback(url.hostname)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("HayaSend returned an unsafe download target.");
  }
  const api = new URL(baseUrl);
  const equivalentLoopback =
    isLoopback(api.hostname) &&
    isLoopback(url.hostname) &&
    api.protocol === url.protocol &&
    api.port === url.port;
  if (
    url.origin !== api.origin &&
    !equivalentLoopback &&
    (url.protocol !== "https:" || !isAwsS3Hostname(url.hostname))
  ) {
    throw new Error(
      "HayaSend returned a download target outside its API origin or AWS S3.",
    );
  }
  return url.toString();
}

function filesystemError(error: unknown, fallback: string): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return new Error(`${fallback} (${error.code}).`);
  }
  return new Error(`${fallback}.`);
}

export async function prepareDownloadOutput(
  cwd: string,
  configuredPath: string,
  force: boolean,
): Promise<PreparedDownloadOutput> {
  if (configuredPath.length === 0 || /[\u0000\r\n]/.test(configuredPath)) {
    throw new Error("--output must be a non-empty local file path.");
  }
  const unresolved = resolve(cwd, configuredPath);
  const filename = basename(unresolved);
  if (!filename || filename === "." || filename === "..") {
    throw new Error("--output must identify a local file.");
  }
  let directory: string;
  try {
    directory = await realpath(dirname(unresolved));
  } catch (error) {
    throw filesystemError(error, "The output directory is unavailable");
  }
  const path = join(directory, filename);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw filesystemError(error, "The output path could not be inspected");
    }
  }
  if (existing?.isDirectory()) {
    throw new Error("--output must identify a file, not a directory.");
  }
  if (existing && !force) {
    throw new Error(
      "Refusing to overwrite the existing output file; add --force to replace it.",
    );
  }
  return { directory, force, path };
}

async function readDownload(
  url: string,
  expectedBytes: number | undefined,
  context: DownloadContext,
) {
  let response: Response;
  try {
    response = await context.fetch(url, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Download request failed.");
  }
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}.`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new Error("Download returned an invalid content length.");
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      throw new Error("Download returned an invalid content length.");
    }
    if (declaredBytes > MAX_DOWNLOAD_BYTES) {
      throw new Error("Download exceeds the 25 MiB limit.");
    }
    if (expectedBytes !== undefined && declaredBytes !== expectedBytes) {
      throw new Error("Download size does not match attachment metadata.");
    }
  }
  if (!response.body) {
    throw new Error("Download returned no content.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadLimitError(
          "Download exceeds the 25 MiB limit.",
        );
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof DownloadLimitError) {
      throw error;
    }
    throw new Error("Download request failed.");
  }
  if (expectedBytes !== undefined && totalBytes !== expectedBytes) {
    throw new Error("Download size does not match attachment metadata.");
  }
  const content = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

async function writeAtomically(
  output: PreparedDownloadOutput,
  content: Uint8Array,
) {
  const temporaryPath = join(
    output.directory,
    `.${basename(output.path)}.hayasend-${randomUUID()}.tmp`,
  );
  const file = await open(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  try {
    await file.writeFile(content);
    await file.sync();
    await file.close();
    closed = true;
    if (output.force) {
      await rename(temporaryPath, output.path);
    } else {
      try {
        await link(temporaryPath, output.path);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          throw new Error(
            "Refusing to overwrite the existing output file; add --force to replace it.",
          );
        }
        throw filesystemError(error, "The downloaded file could not be saved");
      }
      await unlink(temporaryPath);
    }
  } catch (error) {
    if (!closed) {
      await file.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function downloadToFile(
  downloadUrl: unknown,
  output: PreparedDownloadOutput,
  context: DownloadContext,
  expectedBytes?: number,
  minimumBytes = 0,
) {
  if (
    expectedBytes !== undefined &&
    (!Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0 ||
      expectedBytes > MAX_DOWNLOAD_BYTES)
  ) {
    throw new Error("Attachment size is outside the 25 MiB download limit.");
  }
  const safeUrl = safeDownloadUrl(downloadUrl, context.baseUrl);
  const content = await readDownload(safeUrl, expectedBytes, context);
  if (content.byteLength < minimumBytes) {
    throw new Error("Download returned no content.");
  }
  await writeAtomically(output, content);
  return {
    path: output.path,
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
