import { PORTABLE_RUNTIME_CAPABILITIES } from "../adapters/portable-runtime-capabilities.js";
import { SENDGRID_EMAIL_CAPABILITIES } from "../adapters/sendgrid/sendgrid-email-capabilities.js";
import { VERCEL_RUNTIME_CAPABILITIES } from "../adapters/vercel-runtime-capabilities.js";
import {
  validateDeploymentCapabilityDocument,
  type DeploymentCapabilityDocument,
  type RuntimeCapabilityDocument,
} from "../core/runtime-capabilities.js";
import { HAYASEND_VERSION } from "../version.js";

interface SendGridDeploymentInput {
  deployment: string;
  runtime: RuntimeCapabilityDocument;
  runtimeCapabilityDocument:
    | "conformance/runtimes/portable-postgres.v1.json"
    | "conformance/runtimes/vercel-serverless.v1.json";
  proofIssue: number;
}

function effectiveLimits(runtime: RuntimeCapabilityDocument) {
  const provider = SENDGRID_EMAIL_CAPABILITIES.limits;
  const maxPayload = runtime.limits.max_payload_bytes;
  return {
    max_serialized_request_bytes: Math.min(
      provider.max_serialized_request_bytes,
      maxPayload,
    ),
    max_mime_message_bytes: Math.min(
      provider.max_mime_message_bytes,
      maxPayload,
    ),
    max_combined_recipients: provider.max_combined_recipients,
    max_attachments: provider.max_attachments,
    max_decoded_attachment_bytes: Math.min(
      provider.max_decoded_attachment_bytes,
      maxPayload,
    ),
    max_batch_messages: provider.max_batch_messages,
    max_schedule_delay_seconds: Math.min(
      provider.max_schedule_delay_seconds,
      runtime.limits.max_schedule_delay_seconds,
    ),
  };
}

function sendGridDeployment(
  input: SendGridDeploymentInput,
): DeploymentCapabilityDocument {
  const issueUrl = `https://github.com/haya-inc/hayasend/issues/${input.proofIssue}`;
  return validateDeploymentCapabilityDocument(
    {
      schema_version: "1.0.0",
      deployment: input.deployment,
      adapter_version: HAYASEND_VERSION,
      checked_at: "2026-07-29",
      runtime: {
        profile: input.runtime.runtime,
        adapter_version: input.runtime.adapter_version,
        capability_document: input.runtimeCapabilityDocument,
      },
      transport: {
        provider: SENDGRID_EMAIL_CAPABILITIES.provider,
        adapter_version: SENDGRID_EMAIL_CAPABILITIES.adapter_version,
        capability_document: "conformance/providers/sendgrid.v1.json",
      },
      maturity: {
        runtime: input.runtime.service_maturity,
        transport: SENDGRID_EMAIL_CAPABILITIES.service_maturity,
        combination: "experimental",
      },
      production_ready: false,
      effective_limits: effectiveLimits(input.runtime),
      evidence: {
        conformance: {
          status: "pending",
          url: issueUrl,
          notes:
            "The shared SendGrid adapter passes local contract tests; exact hosted conformance remains pending.",
        },
        lifecycle: {
          status: "pending",
          url: issueUrl,
          notes:
            "An isolated hosted deploy, migration, doctor, controlled failure, upgrade, and rollback drill has not yet passed.",
        },
        terminal_delivery: {
          status: "pending",
          url: issueUrl,
          notes:
            "SendGrid acceptance and a signed recipient-level terminal event have not yet converged on exact main in this host.",
        },
        controlled_receipt: {
          status: "pending",
          url: issueUrl,
          notes:
            "A uniquely identified message has not yet been confirmed in a controlled mailbox for this exact deployment.",
        },
        cleanup: {
          status: "pending",
          url: issueUrl,
          notes:
            "The isolated hosted resources have not yet passed zero-residue cleanup verification.",
        },
      },
      privacy: {
        customer_owned_data_plane: true,
        management_plane_content_exported_by_default: false,
        addresses_exported_by_default: false,
        raw_provider_errors_retained: false,
      },
      limitations: [
        `Production readiness remains false while issue #${input.proofIssue} is incomplete.`,
        "A customer-owned SendGrid account, scoped API key, authenticated domain, and Signed Event Webhook are required.",
        "Provider acceptance is not terminal delivery, and the Mail Send API has no provider-enforced idempotency key.",
        "Only opaque HayaSend correlation values are copied to SendGrid custom arguments.",
      ],
    },
    input.runtime,
    SENDGRID_EMAIL_CAPABILITIES,
  );
}

export const CLOUD_RUN_SENDGRID_DEPLOYMENT_CAPABILITIES =
  sendGridDeployment({
    deployment: "cloud-run-sendgrid",
    runtime: PORTABLE_RUNTIME_CAPABILITIES,
    runtimeCapabilityDocument:
      "conformance/runtimes/portable-postgres.v1.json",
    proofIssue: 144,
  });

export const RENDER_SENDGRID_DEPLOYMENT_CAPABILITIES =
  sendGridDeployment({
    deployment: "render-sendgrid",
    runtime: PORTABLE_RUNTIME_CAPABILITIES,
    runtimeCapabilityDocument:
      "conformance/runtimes/portable-postgres.v1.json",
    proofIssue: 146,
  });

export const RAILWAY_SENDGRID_DEPLOYMENT_CAPABILITIES =
  sendGridDeployment({
    deployment: "railway-sendgrid",
    runtime: PORTABLE_RUNTIME_CAPABILITIES,
    runtimeCapabilityDocument:
      "conformance/runtimes/portable-postgres.v1.json",
    proofIssue: 148,
  });

export const FLYIO_SENDGRID_DEPLOYMENT_CAPABILITIES =
  sendGridDeployment({
    deployment: "flyio-sendgrid",
    runtime: PORTABLE_RUNTIME_CAPABILITIES,
    runtimeCapabilityDocument:
      "conformance/runtimes/portable-postgres.v1.json",
    proofIssue: 150,
  });

export const VERCEL_SENDGRID_DEPLOYMENT_CAPABILITIES =
  sendGridDeployment({
    deployment: "vercel-sendgrid",
    runtime: VERCEL_RUNTIME_CAPABILITIES,
    runtimeCapabilityDocument:
      "conformance/runtimes/vercel-serverless.v1.json",
    proofIssue: 155,
  });

export const SENDGRID_DEPLOYMENT_CAPABILITIES = [
  CLOUD_RUN_SENDGRID_DEPLOYMENT_CAPABILITIES,
  FLYIO_SENDGRID_DEPLOYMENT_CAPABILITIES,
  RAILWAY_SENDGRID_DEPLOYMENT_CAPABILITIES,
  RENDER_SENDGRID_DEPLOYMENT_CAPABILITIES,
  VERCEL_SENDGRID_DEPLOYMENT_CAPABILITIES,
] as const;
