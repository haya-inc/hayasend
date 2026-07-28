import { z } from "zod";
import {
  capabilitySupportSchema,
  type ProviderCapabilityDocument,
} from "./provider-capabilities.js";

export const RUNTIME_CAPABILITY_SCHEMA_VERSION = "1.0.0" as const;
export const DEPLOYMENT_CAPABILITY_SCHEMA_VERSION = "1.0.0" as const;
export const READINESS_MATRIX_SCHEMA_VERSION = "1.0.0" as const;

const semanticVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const identifierSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const httpsUrlSchema = z.url().startsWith("https://");
const maturitySchema = z.enum(["experimental", "beta", "production"]);

const sourceSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    url: httpsUrlSchema,
    checked_at: isoDateSchema,
  })
  .strict();

export const runtimeCapabilityDocumentSchema = z
  .object({
    schema_version: z.literal(RUNTIME_CAPABILITY_SCHEMA_VERSION),
    runtime: identifierSchema,
    adapter_version: semanticVersionSchema,
    checked_at: isoDateSchema,
    service_maturity: maturitySchema,
    runtime_class: z.enum([
      "native-cloud",
      "portable-container",
      "serverless",
    ]),
    required_plan: z.string().trim().min(1).max(1_000),
    limits: z
      .object({
        max_payload_bytes: z.number().int().positive(),
        max_schedule_delay_seconds: z.number().int().nonnegative(),
        reconciliation_interval_seconds: z.number().int().positive(),
      })
      .strict(),
    authority: z
      .object({
        durable_store: z.literal("metadata-ledger-outbox"),
        atomic_message_outbox_commit: z.literal(true),
        queue_is_source_of_truth: z.literal(false),
        scheduler_is_source_of_truth: z.literal(false),
        due_row_reconciliation: z.literal(true),
      })
      .strict(),
    components: z
      .object({
        atomic_store: capabilitySupportSchema,
        recipient_ledger: capabilitySupportSchema,
        payload_store: capabilitySupportSchema,
        queue_wakeup: capabilitySupportSchema,
        scheduler_wakeup: capabilitySupportSchema,
        periodic_reconciliation: capabilitySupportSchema,
        secret_injection: capabilitySupportSchema,
        provider_event_ingress: capabilitySupportSchema,
        webhook_egress: capabilitySupportSchema,
        backup_restore: capabilitySupportSchema,
      })
      .strict(),
    lifecycle: z
      .object({
        safe_deploy: capabilitySupportSchema,
        doctor: capabilitySupportSchema,
        upgrade: capabilitySupportSchema,
        rollback: capabilitySupportSchema,
        cleanup: capabilitySupportSchema,
      })
      .strict(),
    privacy: z
      .object({
        content_stored_in_customer_account: z.literal(true),
        management_plane_content_exported_by_default: z.literal(false),
        addresses_exported_by_default: z.literal(false),
        raw_operational_errors_retained: z.literal(false),
      })
      .strict(),
    sources: z.array(sourceSchema).min(1),
    limitations: z.array(z.string().trim().min(1).max(1_000)),
  })
  .strict()
  .meta({
    id: "https://hayasend.dev/schemas/runtime-capabilities.v1.schema.json",
    title: "HayaSend runtime capability document",
    description:
      "Versioned, privacy-safe capabilities and limits for one customer-owned HayaSend runtime substrate.",
  });

const evidenceStatusSchema = z.enum(["passed", "failed", "pending"]);

const evidenceSchema = z
  .object({
    status: evidenceStatusSchema,
    url: httpsUrlSchema,
    notes: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const deploymentCapabilityDocumentSchema = z
  .object({
    schema_version: z.literal(DEPLOYMENT_CAPABILITY_SCHEMA_VERSION),
    deployment: identifierSchema,
    adapter_version: semanticVersionSchema,
    checked_at: isoDateSchema,
    runtime: z
      .object({
        profile: identifierSchema,
        adapter_version: semanticVersionSchema,
        capability_document:
          z.string().regex(/^conformance\/runtimes\/[a-z0-9-]+\.v1\.json$/),
      })
      .strict(),
    transport: z
      .object({
        provider: identifierSchema,
        adapter_version: semanticVersionSchema,
        capability_document:
          z.string().regex(/^conformance\/providers\/[a-z0-9-]+\.v1\.json$/),
      })
      .strict(),
    maturity: z
      .object({
        runtime: maturitySchema,
        transport: maturitySchema,
        combination: maturitySchema,
      })
      .strict(),
    production_ready: z.boolean(),
    effective_limits: z
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
    evidence: z
      .object({
        conformance: evidenceSchema,
        lifecycle: evidenceSchema,
        terminal_delivery: evidenceSchema,
        controlled_receipt: evidenceSchema,
        cleanup: evidenceSchema,
      })
      .strict(),
    privacy: z
      .object({
        customer_owned_data_plane: z.literal(true),
        management_plane_content_exported_by_default: z.literal(false),
        addresses_exported_by_default: z.literal(false),
        raw_provider_errors_retained: z.literal(false),
      })
      .strict(),
    limitations: z.array(z.string().trim().min(1).max(1_000)),
  })
  .strict()
  .meta({
    id: "https://hayasend.dev/schemas/deployment-capabilities.v1.schema.json",
    title: "HayaSend deployment capability document",
    description:
      "Binds one runtime substrate to one mail transport and prevents readiness from exceeding the weakest component or evidence gate.",
  });

export type RuntimeCapabilityDocument = z.infer<
  typeof runtimeCapabilityDocumentSchema
>;
export type DeploymentCapabilityDocument = z.infer<
  typeof deploymentCapabilityDocumentSchema
>;

const readinessEvidenceSchema = z
  .object({
    conformance: evidenceStatusSchema,
    lifecycle: evidenceStatusSchema,
    terminal_delivery: evidenceStatusSchema,
    controlled_receipt: evidenceStatusSchema,
    cleanup: evidenceStatusSchema,
  })
  .strict();

const readinessBlockerSchema = z.enum([
  "conformance",
  "lifecycle",
  "terminal_delivery",
  "controlled_receipt",
  "cleanup",
]);

type ReadinessBlocker = z.infer<typeof readinessBlockerSchema>;

const READINESS_GATES = [
  "conformance",
  "lifecycle",
  "terminal_delivery",
  "controlled_receipt",
  "cleanup",
] as const satisfies readonly ReadinessBlocker[];

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const readinessDeploymentSchema = z
  .object({
    deployment: identifierSchema,
    checked_at: isoDateSchema,
    runtime: identifierSchema,
    transport: identifierSchema,
    maturity: maturitySchema,
    production_ready: z.boolean(),
    evidence: readinessEvidenceSchema,
    blockers: z.array(readinessBlockerSchema),
  })
  .strict()
  .superRefine((deployment, context) => {
    const expected = READINESS_GATES.filter(
      (gate) => deployment.evidence[gate] !== "passed",
    );
    if (
      deployment.blockers.length !== expected.length ||
      deployment.blockers.some((blocker, index) => blocker !== expected[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["blockers"],
        message:
          "readiness blockers must exactly match non-passed evidence gates in canonical order",
      });
    }
  });

export const readinessMatrixSchema = z
  .object({
    schema_version: z.literal(READINESS_MATRIX_SCHEMA_VERSION),
    deployments: z
      .array(readinessDeploymentSchema)
      .min(1)
      .refine(
        (deployments) =>
          new Set(deployments.map(({ deployment }) => deployment)).size ===
          deployments.length,
        { message: "readiness deployment identities must be unique" },
      )
      .refine(
        (deployments) =>
          deployments.every(
            ({ deployment }, index) =>
              index === 0 ||
              compareIdentifiers(
                deployments[index - 1]!.deployment,
                deployment,
              ) <= 0,
          ),
        { message: "readiness deployments must be sorted by identity" },
      ),
  })
  .strict()
  .meta({
    id: "https://hayasend.dev/schemas/readiness-matrix.v1.schema.json",
    title: "HayaSend deployment readiness matrix",
    description:
      "A generated summary of exact runtime and transport combinations and their incomplete operational evidence gates.",
  });

export type ReadinessMatrix = z.infer<typeof readinessMatrixSchema>;

export function buildReadinessMatrix(
  documents: readonly DeploymentCapabilityDocument[],
): ReadinessMatrix {
  return readinessMatrixSchema.parse({
    schema_version: READINESS_MATRIX_SCHEMA_VERSION,
    deployments: [...documents]
      .sort((left, right) =>
        compareIdentifiers(left.deployment, right.deployment),
      )
      .map((document) => {
        const evidence = {
          conformance: document.evidence.conformance.status,
          lifecycle: document.evidence.lifecycle.status,
          terminal_delivery: document.evidence.terminal_delivery.status,
          controlled_receipt: document.evidence.controlled_receipt.status,
          cleanup: document.evidence.cleanup.status,
        };
        return {
          deployment: document.deployment,
          checked_at: document.checked_at,
          runtime: document.runtime.profile,
          transport: document.transport.provider,
          maturity: document.maturity.combination,
          production_ready: document.production_ready,
          evidence,
          blockers: READINESS_GATES.filter(
            (gate) => evidence[gate] !== "passed",
          ),
        };
      }),
  });
}

const MATURITY_RANK = {
  experimental: 0,
  beta: 1,
  production: 2,
} as const;

export function validateDeploymentCapabilityDocument(
  input: unknown,
  runtime: RuntimeCapabilityDocument,
  transport: ProviderCapabilityDocument,
): DeploymentCapabilityDocument {
  const document = deploymentCapabilityDocumentSchema.parse(input);

  if (
    document.runtime.profile !== runtime.runtime ||
    document.runtime.adapter_version !== runtime.adapter_version
  ) {
    throw new Error(
      "Deployment runtime identity does not match its runtime capability document.",
    );
  }
  if (
    document.transport.provider !== transport.provider ||
    document.transport.adapter_version !== transport.adapter_version
  ) {
    throw new Error(
      "Deployment transport identity does not match its provider capability document.",
    );
  }
  if (
    document.maturity.runtime !== runtime.service_maturity ||
    document.maturity.transport !== transport.service_maturity
  ) {
    throw new Error(
      "Deployment component maturity does not match its capability documents.",
    );
  }

  const weakestMaturity = Math.min(
    MATURITY_RANK[runtime.service_maturity],
    MATURITY_RANK[transport.service_maturity],
  );
  if (MATURITY_RANK[document.maturity.combination] > weakestMaturity) {
    throw new Error(
      "Deployment combination maturity cannot exceed its weakest component.",
    );
  }

  const maximumScheduleDelay = Math.min(
    runtime.limits.max_schedule_delay_seconds,
    transport.limits.max_schedule_delay_seconds,
  );
  if (
    document.effective_limits.max_schedule_delay_seconds >
    maximumScheduleDelay
  ) {
    throw new Error(
      "Deployment schedule limit exceeds a component capability document.",
    );
  }
  if (
    document.effective_limits.max_mime_message_bytes >
      runtime.limits.max_payload_bytes ||
    document.effective_limits.max_mime_message_bytes >
      transport.limits.max_mime_message_bytes
  ) {
    throw new Error(
      "Deployment message limit exceeds a component capability document.",
    );
  }
  for (const limit of [
    "max_serialized_request_bytes",
    "max_combined_recipients",
    "max_attachments",
    "max_decoded_attachment_bytes",
    "max_batch_messages",
  ] as const) {
    if (
      document.effective_limits[limit] > transport.limits[limit]
    ) {
      throw new Error(
        `Deployment ${limit} exceeds its provider capability document.`,
      );
    }
  }

  if (document.production_ready) {
    if (document.maturity.combination !== "production") {
      throw new Error(
        "A production-ready deployment must have production combination maturity.",
      );
    }
    const incompleteEvidence = Object.entries(document.evidence).find(
      ([, evidence]) => evidence.status !== "passed",
    );
    if (incompleteEvidence) {
      throw new Error(
        `A production-ready deployment requires passed ${incompleteEvidence[0]} evidence.`,
      );
    }
  }

  return document;
}
