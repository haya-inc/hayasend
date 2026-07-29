import { ACS_EMAIL_CAPABILITIES } from "../adapters/azure/acs-email-capabilities.js";
import { PORTABLE_RUNTIME_CAPABILITIES } from "../adapters/portable-runtime-capabilities.js";
import {
  validateDeploymentCapabilityDocument,
  type DeploymentCapabilityDocument,
} from "../core/runtime-capabilities.js";
import { HAYASEND_VERSION } from "../version.js";

const issueUrl = "https://github.com/haya-inc/hayasend/issues/152";

export const AZURE_CONTAINER_APPS_ACS_DEPLOYMENT_CAPABILITIES =
  validateDeploymentCapabilityDocument(
    {
      schema_version: "1.0.0",
      deployment: "azure-container-apps-acs",
      adapter_version: HAYASEND_VERSION,
      checked_at: "2026-07-29",
      runtime: {
        profile: PORTABLE_RUNTIME_CAPABILITIES.runtime,
        adapter_version: PORTABLE_RUNTIME_CAPABILITIES.adapter_version,
        capability_document:
          "conformance/runtimes/portable-postgres.v1.json",
      },
      transport: {
        provider: ACS_EMAIL_CAPABILITIES.provider,
        adapter_version: ACS_EMAIL_CAPABILITIES.adapter_version,
        capability_document:
          "conformance/providers/azure-communication-services.v1.json",
      },
      maturity: {
        runtime: PORTABLE_RUNTIME_CAPABILITIES.service_maturity,
        transport: ACS_EMAIL_CAPABILITIES.service_maturity,
        combination: "experimental",
      },
      production_ready: false,
      effective_limits: {
        ...ACS_EMAIL_CAPABILITIES.limits,
        max_serialized_request_bytes: Math.min(
          PORTABLE_RUNTIME_CAPABILITIES.limits.max_payload_bytes,
          ACS_EMAIL_CAPABILITIES.limits.max_serialized_request_bytes,
        ),
        max_mime_message_bytes: Math.min(
          PORTABLE_RUNTIME_CAPABILITIES.limits.max_payload_bytes,
          ACS_EMAIL_CAPABILITIES.limits.max_mime_message_bytes,
        ),
        max_schedule_delay_seconds: Math.min(
          PORTABLE_RUNTIME_CAPABILITIES.limits.max_schedule_delay_seconds,
          ACS_EMAIL_CAPABILITIES.limits.max_schedule_delay_seconds,
        ),
      },
      evidence: {
        conformance: {
          status: "pending",
          url: issueUrl,
          notes:
            "The shared PostgreSQL and ACS adapter contracts pass locally; exact hosted recipient convergence remains pending.",
        },
        lifecycle: {
          status: "pending",
          url: issueUrl,
          notes:
            "An isolated Azure deploy, migration, failure drill, upgrade, and rollback has not yet passed.",
        },
        terminal_delivery: {
          status: "pending",
          url: issueUrl,
          notes:
            "ACS acceptance and exact-recipient Event Grid terminal delivery have not yet converged on an isolated hosted deployment.",
        },
        controlled_receipt: {
          status: "pending",
          url: issueUrl,
          notes:
            "A uniquely identified ACS message has not yet been confirmed in a controlled mailbox for this exact deployment.",
        },
        cleanup: {
          status: "pending",
          url: issueUrl,
          notes:
            "The isolated Azure resource graph has not yet passed zero-residue cleanup and billing verification.",
        },
      },
      privacy: {
        customer_owned_data_plane: true,
        management_plane_content_exported_by_default: false,
        addresses_exported_by_default: false,
        raw_provider_errors_retained: false,
      },
      limitations: [
        "Production readiness remains false while issue #152 is incomplete.",
        "A customer-owned custom ACS Email domain, approved quota, and authenticated Event Grid ingress are required.",
        "Provider acceptance is not terminal delivery, and ACS does not provide provider-enforced send idempotency.",
        "Multi-recipient engagement events are retained without guessing a recipient because ACS can omit the recipient.",
      ],
    },
    PORTABLE_RUNTIME_CAPABILITIES,
    ACS_EMAIL_CAPABILITIES,
  ) satisfies DeploymentCapabilityDocument;
