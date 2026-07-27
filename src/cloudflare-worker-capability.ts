import { CLOUDFLARE_EMAIL_CAPABILITIES } from "./adapters/cloudflare/cloudflare-email-capabilities.js";
import { sha256 } from "./core/crypto.js";

const capabilityBase = {
  schema_version: "1.0.0",
  runtime: "cloudflare-workers",
  maturity: "beta-proof",
  production_ready: false,
  api: {
    health: true,
    capabilities: true,
    email_api: true,
    email_send: true,
    email_batch_send: true,
    email_get: true,
    email_list: true,
    templates: false,
    uploaded_attachments: false,
    domains: false,
    webhooks: false,
    inbound_email: false,
  },
  adapters: {
    metadata_store: "d1",
    payload_storage: "r2",
    queue: "cloudflare-queues",
    scheduler: "queue-delay-plus-cron",
    mail_transport: "cloudflare-email-sending-beta",
    email_sending_events: "cloudflare-queues",
    inbound_email: false,
  },
  provider_capability_digest: sha256(
    JSON.stringify(CLOUDFLARE_EMAIL_CAPABILITIES),
  ),
  limitations: [
    "Cloudflare Email Sending is Beta and this runtime is not production-ready.",
    "Only send, batch send, retrieve, and list are exposed in the Cloudflare proof.",
    "Uploaded attachment references, hosted templates, domains, webhooks, and inbound email are unavailable.",
    "Open events, click events, and provider-side send idempotency are unsupported.",
    "Inline canonical-base64 attachments are bounded by the Cloudflare 5 MiB message preflight.",
  ],
} as const;

export const CLOUDFLARE_WORKER_CAPABILITY = Object.freeze({
  ...capabilityBase,
  capability_digest: sha256(JSON.stringify(capabilityBase)),
});
