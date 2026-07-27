import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import {
  request as httpsRequest,
  type RequestOptions,
} from "node:https";
import {
  BlockList,
  isIP,
  type LookupFunction,
} from "node:net";
import { ValidationError } from "../core/errors.js";
import {
  assertWebhookEndpointShape,
  type WebhookHttpClient,
  type WebhookHttpResponse,
} from "../core/network-safety.js";

const DNS_TIMEOUT_MS = 5_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

const nonPublicAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

export type HostResolver = (
  hostname: string,
) => Promise<LookupAddress[]>;

export const resolveHost: HostResolver = async (hostname) =>
  lookup(hostname, { all: true, order: "verbatim" });

function normalizedIpHostname(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isPublicIpAddress(address: string) {
  const family = isIP(address);
  return (
    family !== 0 &&
    !nonPublicAddresses.check(
      address,
      family === 4 ? "ipv4" : "ipv6",
    )
  );
}

async function publicAddresses(
  hostname: string,
  resolve: HostResolver,
) {
  const normalized = normalizedIpHostname(hostname);
  const literalFamily = isIP(normalized);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await Promise.race([
        resolve(normalized),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Webhook DNS resolution timed out.")),
            DNS_TIMEOUT_MS,
          );
        }),
      ]).finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        family !== isIP(address) || !isPublicIpAddress(address),
    )
  ) {
    throw new ValidationError(
      "Webhook endpoints must resolve only to public IP addresses.",
    );
  }
  return addresses;
}

export async function assertPublicWebhookEndpoint(
  endpoint: URL,
  resolve: HostResolver = resolveHost,
) {
  assertWebhookEndpointShape(endpoint);
  if (endpoint.protocol !== "https:") {
    throw new ValidationError(
      "Webhook endpoint must be a public HTTPS URL.",
    );
  }
  try {
    await publicAddresses(endpoint.hostname, resolve);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(
      "Webhook endpoint hostname could not be resolved.",
    );
  }
}

export function createPublicLookup(
  resolve: HostResolver = resolveHost,
): LookupFunction {
  return (hostname, options, callback) => {
    publicAddresses(hostname, resolve)
      .then((addresses) => {
        const candidates =
          options.family === 4 || options.family === 6
            ? addresses.filter(
                ({ family }) => family === options.family,
              )
            : addresses;
        if (candidates.length === 0) {
          const error = new Error(
            "Webhook endpoint has no public address in the requested family.",
          ) as NodeJS.ErrnoException;
          error.code = "ENOTFOUND";
          callback(error, [], 0);
          return;
        }
        if (options.all) {
          callback(null, candidates, candidates[0]?.family);
          return;
        }
        const first = candidates[0];
        callback(null, first?.address ?? "", first?.family);
      })
      .catch((error: unknown) => {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          [],
          0,
        );
      });
  };
}

export function createSafeWebhookFetch(
  resolve: HostResolver = resolveHost,
): WebhookHttpClient {
  return async (input, init) => {
    const request = new Request(input, init);
    const endpoint = new URL(request.url);
    await assertPublicWebhookEndpoint(endpoint, resolve);
    const body = request.body
      ? new Uint8Array(await request.arrayBuffer())
      : undefined;
    const headers = Object.fromEntries(request.headers.entries());
    if (body) {
      headers["content-length"] = String(body.byteLength);
    }
    const options: RequestOptions = {
      method: request.method,
      headers,
      lookup: createPublicLookup(resolve),
      signal: request.signal,
      timeout: WEBHOOK_TIMEOUT_MS,
      maxHeaderSize: 16 * 1_024,
    };
    return new Promise<WebhookHttpResponse>((resolveResponse, reject) => {
      const outbound = httpsRequest(endpoint, options, (response) => {
        const status = response.statusCode ?? 500;
        response.destroy();
        resolveResponse({
          ok: status >= 200 && status < 300,
          status,
        });
      });
      outbound.once("upgrade", (_response, socket) => {
        socket.destroy();
        resolveResponse({ ok: false, status: 502 });
      });
      outbound.once("timeout", () => {
        outbound.destroy(new Error("Webhook request timed out."));
      });
      outbound.once("error", reject);
      if (body) {
        outbound.write(body);
      }
      outbound.end();
    });
  };
}
