/// <reference path="../../worker-configuration.d.ts" />

import { sha256 } from "../core/crypto.js";
import { HAYASEND_VERSION } from "../version.js";

const capabilityBase = {
  schema_version: "1.0.0",
  runtime: "cloudflare-workers",
  maturity: "experimental-substrate",
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
    email_sending_events: false,
    inbound_email: false,
  },
  substrate: {
    d1_delivery_store: "implemented-not-wired",
    r2_payload_storage: "implemented-not-wired",
    queues_job_delivery: "implemented-not-wired",
    email_sending_transport: "implemented-not-wired",
    email_sending_event_consumer: "implemented-not-wired",
    local_fault_contract: true,
  },
  limitations: [
    "No email API is wired to the Workers runtime.",
    "D1, R2, and Queues adapters pass local workerd contract and fault tests but are not configured in this runtime.",
    "The Beta Cloudflare Email Sending transport and event consumer are implemented and tested but no binding or subscription is configured.",
    "Open events, click events, and provider-side send idempotency are unsupported by the current Cloudflare Email Sending contract.",
    "No scheduler, deployment lifecycle, or inbound adapter is configured.",
    "This experimental substrate must not be deployed for production traffic.",
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
        status: "experimental-substrate",
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
            "The Cloudflare Workers runtime is an experimental substrate and does not expose the HayaSend email API.",
        },
      },
      404,
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;
