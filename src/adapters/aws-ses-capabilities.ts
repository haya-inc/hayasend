import {
  providerCapabilityDocumentSchema,
  type ProviderCapabilityDocument,
} from "../core/provider-capabilities.js";

const MEBIBYTE = 1024 * 1024;

export const AWS_SES_CAPABILITIES = providerCapabilityDocumentSchema.parse({
  schema_version: "1.0.0",
  provider: "aws-ses",
  adapter_version: "0.1.0",
  checked_at: "2026-07-26",
  service_maturity: "beta",
  required_plan:
    "An AWS account with Amazon SES production access in the deployment Region is required for unverified recipients.",
  limits: {
    max_serialized_request_bytes: 9 * MEBIBYTE,
    max_mime_message_bytes: 39 * MEBIBYTE,
    max_combined_recipients: 50,
    max_attachments: 20,
    max_decoded_attachment_bytes: 25 * MEBIBYTE,
    max_batch_messages: 100,
    max_schedule_delay_seconds: 30 * 86_400,
  },
  features: {
    attachments: {
      status: "supported",
      notes:
        "Inline base64 and checksum-bound direct uploads are supported within HayaSend limits.",
    },
    custom_headers: {
      status: "supported",
      notes: "Validated custom headers are passed through the SES v2 API.",
    },
    scheduling: {
      status: "supported",
      notes:
        "SQS handles delays through 15 minutes and EventBridge Scheduler handles later sends through 30 days.",
    },
    cancellation: {
      status: "conditional",
      notes:
        "Queued or scheduled messages can be canceled before provider submission.",
    },
    batch: {
      status: "conditional",
      notes:
        "HayaSend accepts 1 to 100 messages with strict preflight validation; each message is submitted separately.",
    },
    provider_message_id: {
      status: "supported",
      notes: "SES v2 returns a provider message ID for accepted submissions.",
    },
    provider_event_id: {
      status: "unsupported",
      notes:
        "The current adapter does not persist a stable provider-event ID; issue #99 adds immutable event deduplication.",
    },
    provider_idempotency: {
      status: "unsupported",
      notes:
        "SES SendEmail does not expose a durable provider-side idempotency key that HayaSend has verified.",
    },
    domain_verification: {
      status: "supported",
      notes:
        "HayaSend creates and inspects SES email identities without changing DNS automatically.",
    },
    suppression_handling: {
      status: "conditional",
      notes:
        "HayaSend preflights its customer-owned suppression records and SES may additionally apply account or global suppression.",
    },
  },
  events: {
    accepted: {
      status: "supported",
      notes: "HayaSend records synchronous SES acceptance.",
    },
    delivered: {
      status: "supported",
      notes: "SES configuration-set delivery events are consumed through SNS.",
    },
    delayed: {
      status: "supported",
      notes:
        "SES configuration-set delivery-delay events are consumed through SNS.",
    },
    bounced: {
      status: "supported",
      notes:
        "SES configuration-set bounce events are consumed and permanent bounces create suppressions.",
    },
    complained: {
      status: "supported",
      notes:
        "SES configuration-set complaint events are consumed and create suppressions.",
    },
    rejected: {
      status: "supported",
      notes:
        "Synchronous request rejection and SES reject/rendering-failure events map to privacy-safe failure categories.",
    },
    opened: {
      status: "supported",
      notes:
        "SES open tracking events are supported when operator configuration and recipient clients allow them.",
    },
    clicked: {
      status: "supported",
      notes:
        "SES click tracking events are supported when operator configuration and recipient clients allow them.",
    },
  },
  error_mapping: {
    retryable_categories: [
      "application_error",
      "network_dns",
      "network_refused",
      "network_reset",
      "provider_error",
      "provider_throttled",
      "provider_unavailable",
      "timeout",
    ],
    permanent_categories: ["invalid_data", "provider_rejected"],
    unknown_error_behavior: "retry",
  },
  privacy: {
    content_exported_by_default: false,
    addresses_exported_by_default: false,
    raw_provider_errors_retained: false,
  },
  sources: [
    {
      title: "Amazon SES service quotas",
      url: "https://docs.aws.amazon.com/ses/latest/dg/quotas.html",
      checked_at: "2026-07-26",
    },
    {
      title: "Amazon SES v2 event destination",
      url: "https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_EventDestination.html",
      checked_at: "2026-07-26",
    },
    {
      title: "Amazon SES SNS event contents",
      url: "https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html",
      checked_at: "2026-07-26",
    },
  ],
  limitations: [
    "The v0.1 adapter stores one aggregate message status rather than canonical recipient-level history.",
    "A provider acceptance followed by a crash before the attempt update remains an explicit duplicate-send ambiguity.",
    "Open and click evidence depends on tracking configuration and recipient-client behavior.",
  ],
}) satisfies ProviderCapabilityDocument;
