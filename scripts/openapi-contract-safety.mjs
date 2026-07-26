import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

function normalizedHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackHostname(hostname) {
  const normalized = normalizedHostname(hostname);
  if (normalized === "localhost") {
    return true;
  }
  const family = isIP(normalized);
  if (family === 4) {
    return normalized.startsWith("127.");
  }
  if (family === 6) {
    return (
      normalized === "::1" ||
      normalized.toLowerCase().startsWith("::ffff:127.")
    );
  }
  return false;
}

export function normalizeContractBaseUrl(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(
      "HAYASEND_CONTRACT_BASE_URL must be an absolute loopback URL.",
    );
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !isLoopbackHostname(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "HAYASEND_CONTRACT_BASE_URL must use a loopback HTTP(S) origin without credentials, a path, query parameters, or a fragment.",
    );
  }
  return endpoint.origin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(
      `${normalizeContractBaseUrl(
        process.env.HAYASEND_CONTRACT_BASE_URL ?? "",
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
