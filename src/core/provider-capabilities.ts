import { z } from "zod";

export const PROVIDER_CAPABILITY_SCHEMA_VERSION = "1.0.0" as const;
export const CONFORMANCE_RESULT_SCHEMA_VERSION = "1.0.0" as const;

const semanticVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const identifierSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const httpsUrlSchema = z.url().startsWith("https://");

export const capabilityStatusSchema = z.enum([
  "supported",
  "conditional",
  "unsupported",
]);

export const capabilitySupportSchema = z
  .object({
    status: capabilityStatusSchema,
    notes: z.string().trim().min(1).max(1_000),
  })
  .strict();

const providerEventCapabilitiesSchema = z
  .object({
    accepted: capabilitySupportSchema,
    delivered: capabilitySupportSchema,
    delayed: capabilitySupportSchema,
    bounced: capabilitySupportSchema,
    complained: capabilitySupportSchema,
    rejected: capabilitySupportSchema,
    opened: capabilitySupportSchema,
    clicked: capabilitySupportSchema,
  })
  .strict();

const operationalErrorCategorySchema = z.enum([
  "application_error",
  "invalid_data",
  "network_dns",
  "network_refused",
  "network_reset",
  "provider_error",
  "provider_rejected",
  "provider_throttled",
  "provider_unavailable",
  "timeout",
]);

export const providerCapabilityDocumentSchema = z
  .object({
    schema_version: z.literal(PROVIDER_CAPABILITY_SCHEMA_VERSION),
    provider: identifierSchema,
    adapter_version: semanticVersionSchema,
    checked_at: isoDateSchema,
    service_maturity: z.enum(["experimental", "beta", "production"]),
    required_plan: z.string().trim().min(1).max(1_000),
    limits: z
      .object({
        max_serialized_request_bytes: z.number().int().positive(),
        max_mime_message_bytes: z.number().int().positive(),
        max_combined_recipients: z.number().int().positive(),
        max_attachments: z.number().int().nonnegative(),
        max_decoded_attachment_bytes: z.number().int().nonnegative(),
        max_batch_messages: z.number().int().positive(),
        max_schedule_delay_seconds: z.number().int().nonnegative(),
      })
      .strict(),
    features: z
      .object({
        attachments: capabilitySupportSchema,
        custom_headers: capabilitySupportSchema,
        scheduling: capabilitySupportSchema,
        cancellation: capabilitySupportSchema,
        batch: capabilitySupportSchema,
        provider_message_id: capabilitySupportSchema,
        provider_event_id: capabilitySupportSchema,
        provider_idempotency: capabilitySupportSchema,
        domain_verification: capabilitySupportSchema,
        suppression_handling: capabilitySupportSchema,
      })
      .strict(),
    events: providerEventCapabilitiesSchema,
    error_mapping: z
      .object({
        retryable_categories: z
          .array(operationalErrorCategorySchema)
          .min(1)
          .refine((values) => new Set(values).size === values.length, {
            message: "retryable categories must be unique",
          }),
        permanent_categories: z
          .array(operationalErrorCategorySchema)
          .min(1)
          .refine((values) => new Set(values).size === values.length, {
            message: "permanent categories must be unique",
          }),
        unknown_error_behavior: z.literal("retry"),
      })
      .strict(),
    privacy: z
      .object({
        content_exported_by_default: z.literal(false),
        addresses_exported_by_default: z.literal(false),
        raw_provider_errors_retained: z.literal(false),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(300),
            url: httpsUrlSchema,
            checked_at: isoDateSchema,
          })
          .strict(),
      )
      .min(1),
    limitations: z.array(z.string().trim().min(1).max(1_000)),
  })
  .strict()
  .meta({
    id: "https://hayasend.dev/schemas/provider-capabilities.v1.schema.json",
    title: "HayaSend provider capability document",
    description:
      "Versioned, privacy-safe capabilities and limits for one HayaSend provider adapter.",
  });

export const conformanceCaseSchema = z
  .object({
    case_id: identifierSchema,
    boundary: z.string().trim().min(1).max(200),
    injected_condition: z.string().trim().min(1).max(500),
    required_outcome: z.string().trim().min(1).max(1_000),
    required: z.boolean(),
    unsupported_capability_path: z
      .string()
      .regex(/^(features|events)\.[a-z][a-z0-9_]*\.status$/)
      .optional(),
  })
  .strict();

export const conformanceCaseCatalogSchema = z
  .object({
    schema_version: z.literal(CONFORMANCE_RESULT_SCHEMA_VERSION),
    cases: z.array(conformanceCaseSchema).min(1),
  })
  .strict()
  .meta({
    id: "https://hayasend.dev/schemas/conformance-cases.v1.schema.json",
    title: "HayaSend conformance case catalog",
    description:
      "The versioned provider-neutral fault and lifecycle cases every adapter report must address.",
  });

const conformanceCaseResultSchema = z
  .object({
    case_id: identifierSchema,
    status: z.enum(["passed", "failed", "unsupported"]),
    evidence_url: httpsUrlSchema,
    reason: z.string().trim().min(1).max(1_000).optional(),
    capability_path: z
      .string()
      .regex(/^(features|events)\.[a-z][a-z0-9_]*\.status$/)
      .optional(),
  })
  .strict();

export const conformanceResultSchema = z
  .object({
    schema_version: z.literal(CONFORMANCE_RESULT_SCHEMA_VERSION),
    run_id: identifierSchema,
    provider: identifierSchema,
    adapter_version: semanticVersionSchema,
    capability_document_sha256: sha256Schema,
    started_at: z.iso.datetime({ offset: true }),
    completed_at: z.iso.datetime({ offset: true }),
    evidence_url: httpsUrlSchema,
    case_count: z.number().int().positive(),
    summary: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        unsupported: z.number().int().nonnegative(),
      })
      .strict(),
    status: z.enum(["passed", "failed"]),
    results: z.array(conformanceCaseResultSchema).min(1),
  })
  .strict()
  .meta({
    id: "https://hayasend.dev/schemas/conformance-result.v1.schema.json",
    title: "HayaSend provider conformance result",
    description:
      "A privacy-safe report of one adapter run against the versioned HayaSend conformance catalog.",
  });

export type ProviderCapabilityDocument = z.infer<
  typeof providerCapabilityDocumentSchema
>;
export type ConformanceCase = z.infer<typeof conformanceCaseSchema>;
export type ConformanceResult = z.infer<typeof conformanceResultSchema>;

export const CONFORMANCE_CASES = [
  {
    case_id: "api-plain-text-fallback",
    boundary: "API content normalization",
    injected_condition:
      "Direct or batch HTML is supplied with text omitted, explicit, or empty",
    required_outcome:
      "Omitted text is derived before persistence and MIME accounting; explicit text is unchanged; empty text with HTML remains an opt-out.",
    required: true,
  },
  {
    case_id: "api-atomic-commit",
    boundary: "API commit",
    injected_condition: "Failure inside the atomic write",
    required_outcome: "No partial message or idempotency claim is retained.",
    required: true,
  },
  {
    case_id: "outbox-queue-unavailable",
    boundary: "Outbox dispatch",
    injected_condition: "Queue unavailable",
    required_outcome: "The committed item remains due and observable.",
    required: true,
  },
  {
    case_id: "outbox-ack-crash",
    boundary: "Outbox acknowledgement",
    injected_condition: "Crash after queue acceptance",
    required_outcome: "A duplicate deterministic job is safe.",
    required: true,
  },
  {
    case_id: "send-lease-concurrency",
    boundary: "Send lease",
    injected_condition: "Concurrent or expired consumers",
    required_outcome: "Only one active claimant owns a lease.",
    required: true,
  },
  {
    case_id: "provider-permanent-rejection",
    boundary: "Provider call",
    injected_condition: "Permanent rejection",
    required_outcome:
      "The submission is not retried and recipient records retain a terminal reason category.",
    required: true,
  },
  {
    case_id: "provider-throttle",
    boundary: "Provider call",
    injected_condition: "Throttle or provider unavailability",
    required_outcome: "The submission uses bounded retry with backoff.",
    required: true,
  },
  {
    case_id: "provider-acceptance-ambiguity",
    boundary: "Provider acceptance",
    injected_condition: "Crash before the attempt update",
    required_outcome: "The ambiguity is recorded and measurable.",
    required: true,
  },
  {
    case_id: "provider-event-ordering",
    boundary: "Provider events",
    injected_condition: "Duplicate or older event",
    required_outcome:
      "The immutable event is deduplicated and recipient state does not regress.",
    required: true,
  },
  {
    case_id: "recipient-mixed-outcomes",
    boundary: "Recipient aggregate",
    injected_condition: "Mixed delivery and bounce",
    required_outcome:
      "Both recipient outcomes remain canonical and the message aggregate is deterministic.",
    required: true,
  },
  {
    case_id: "payload-orphan",
    boundary: "Payload store",
    injected_condition: "Object write without metadata commit",
    required_outcome: "Bounded orphan cleanup removes the unreferenced object.",
    required: true,
  },
  {
    case_id: "webhook-duplicate",
    boundary: "Webhook",
    injected_condition: "Timeout or duplicate queue job",
    required_outcome: "Automatic retries retain one stable event ID.",
    required: true,
  },
  {
    case_id: "deploy-interruption",
    boundary: "Deploy",
    injected_condition: "Interrupted migration",
    required_outcome: "Retry is safe or a tested rollback is documented.",
    required: true,
  },
  {
    case_id: "telemetry-private-fields",
    boundary: "Telemetry",
    injected_condition: "Adversarial private fields",
    required_outcome:
      "No message content, address, credential, signed URL, or raw provider error leaves the data plane.",
    required: true,
  },
] as const satisfies readonly ConformanceCase[];

function capabilityStatusAtPath(
  document: ProviderCapabilityDocument,
  path: string,
): z.infer<typeof capabilityStatusSchema> | undefined {
  const segments = path.split(".");
  let current: unknown = document;
  for (const segment of segments) {
    if (
      typeof current !== "object" ||
      current === null ||
      !(segment in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return capabilityStatusSchema.safeParse(current).data;
}

export function validateConformanceResult(
  input: unknown,
  capabilities: ProviderCapabilityDocument,
  expectedCapabilityDigest?: string,
): ConformanceResult {
  const result = conformanceResultSchema.parse(input);
  if (
    result.provider !== capabilities.provider ||
    result.adapter_version !== capabilities.adapter_version
  ) {
    throw new Error(
      "Conformance result provider or adapter version does not match its capability document.",
    );
  }
  if (
    expectedCapabilityDigest !== undefined &&
    sha256Schema.parse(expectedCapabilityDigest) !==
      result.capability_document_sha256
  ) {
    throw new Error(
      "Conformance result capability digest does not match its capability document.",
    );
  }
  if (
    new Date(result.completed_at).getTime() <
    new Date(result.started_at).getTime()
  ) {
    throw new Error(
      "Conformance result cannot complete before the run starts.",
    );
  }
  const cases = new Map<string, ConformanceCase>(
    CONFORMANCE_CASES.map((testCase) => [testCase.case_id, testCase]),
  );
  const seen = new Set<string>();
  for (const caseResult of result.results) {
    const testCase = cases.get(caseResult.case_id);
    if (!testCase || seen.has(caseResult.case_id)) {
      throw new Error(
        `Conformance result contains an unknown or duplicate case: ${caseResult.case_id}.`,
      );
    }
    seen.add(caseResult.case_id);
    if (caseResult.status !== "passed" && !caseResult.reason) {
      throw new Error(
        `Non-passing conformance case requires a reason: ${caseResult.case_id}.`,
      );
    }
    if (caseResult.status === "unsupported") {
      if (testCase.required) {
        throw new Error(
          `Required conformance case cannot be unsupported: ${caseResult.case_id}.`,
        );
      }
      if (
        !testCase.unsupported_capability_path ||
        !caseResult.capability_path ||
        caseResult.capability_path !== testCase.unsupported_capability_path ||
        capabilityStatusAtPath(capabilities, caseResult.capability_path) !==
          "unsupported"
      ) {
        throw new Error(
          `Unsupported conformance case lacks a matching unsupported capability: ${caseResult.case_id}.`,
        );
      }
    } else if (caseResult.capability_path) {
      throw new Error(
        `Only unsupported conformance cases may cite a capability path: ${caseResult.case_id}.`,
      );
    }
  }
  if (seen.size !== CONFORMANCE_CASES.length) {
    throw new Error("Conformance result does not cover the complete catalog.");
  }
  const summary = result.results.reduce(
    (counts, caseResult) => ({
      ...counts,
      [caseResult.status]: counts[caseResult.status] + 1,
    }),
    { passed: 0, failed: 0, unsupported: 0 },
  );
  if (
    result.case_count !== result.results.length ||
    result.summary.passed !== summary.passed ||
    result.summary.failed !== summary.failed ||
    result.summary.unsupported !== summary.unsupported ||
    result.status !== (summary.failed === 0 ? "passed" : "failed")
  ) {
    throw new Error("Conformance result summary does not match its cases.");
  }
  return result;
}
