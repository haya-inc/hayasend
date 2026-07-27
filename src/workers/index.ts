/// <reference path="../../worker-configuration.d.ts" />

import { sha256 } from "../core/crypto.js";
import { HAYASEND_VERSION } from "../version.js";

const capabilityBase = {
  schema_version: "1.0.0",
  runtime: "cloudflare-workers",
  maturity: "experimental-skeleton",
  production_ready: false,
  api: {
    health: true,
    capabilities: true,
    email_api: false,
  },
  adapters: {
    metadata_store: false,
    payload_storage: false,
    queue: false,
    scheduler: false,
    mail_transport: false,
    inbound_email: false,
  },
  limitations: [
    "No email API is wired to the Workers runtime.",
    "No provider, persistence, queue, scheduler, or inbound adapter is configured.",
    "This skeleton must not be deployed for production traffic.",
  ],
} as const;

export const CLOUDFLARE_WORKER_CAPABILITY = Object.freeze({
  ...capabilityBase,
  capability_digest: sha256(JSON.stringify(capabilityBase)),
});

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return json({
        service: "hayasend",
        version: HAYASEND_VERSION,
        runtime: CLOUDFLARE_WORKER_CAPABILITY.runtime,
        status: "skeleton",
        production_ready: false,
      });
    }
    if (pathname === "/capabilities") {
      return json(CLOUDFLARE_WORKER_CAPABILITY);
    }
    return json(
      {
        error: {
          name: "not_found",
          message:
            "The Cloudflare Workers runtime is an experimental skeleton and does not expose the HayaSend email API.",
        },
      },
      404,
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;
