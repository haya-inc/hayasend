import { AWS_RUNTIME_CAPABILITIES } from "../adapters/aws-runtime-capabilities.js";
import { AWS_SES_CAPABILITIES } from "../adapters/aws-ses-capabilities.js";
import {
  validateDeploymentCapabilityDocument,
  type DeploymentCapabilityDocument,
} from "../core/runtime-capabilities.js";
import { HAYASEND_VERSION } from "../version.js";

export const AWS_SES_DEPLOYMENT_CAPABILITIES =
  validateDeploymentCapabilityDocument(
    {
      schema_version: "1.0.0",
      deployment: "aws-ses",
      adapter_version: HAYASEND_VERSION,
      checked_at: "2026-08-29",
      runtime: {
        profile: AWS_RUNTIME_CAPABILITIES.runtime,
        adapter_version: AWS_RUNTIME_CAPABILITIES.adapter_version,
        capability_document: "conformance/runtimes/aws-native.v1.json",
      },
      transport: {
        provider: AWS_SES_CAPABILITIES.provider,
        adapter_version: AWS_SES_CAPABILITIES.adapter_version,
        capability_document: "conformance/providers/aws-ses.v1.json",
      },
      maturity: {
        runtime: AWS_RUNTIME_CAPABILITIES.service_maturity,
        transport: AWS_SES_CAPABILITIES.service_maturity,
        combination: "production",
      },
      production_ready: true,
      effective_limits: AWS_SES_CAPABILITIES.limits,
      evidence: {
        conformance: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/126",
          notes:
            "Issue #126 records exact-main hosted conformance and official-SDK terminal delivery evidence.",
        },
        lifecycle: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/174",
          notes:
            "Protected deployment, gradual upgrade, alarm-driven rollback, backup/restore, and zero-residue cleanup passed in the dedicated account.",
        },
        terminal_delivery: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/126",
          notes:
            "Issue #126 proves SES acceptance, provider ID and SNS event correlation, and exact-recipient delivered convergence.",
        },
        controlled_receipt: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/126",
          notes:
            "Issue #126 records controlled mailbox receipt for the exact unique test message outside spam and trash.",
        },
        cleanup: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/126",
          notes:
            "The exact-main terminal proof and independent audit verified zero run-scoped AWS residue.",
        },
      },
      privacy: {
        customer_owned_data_plane: true,
        management_plane_content_exported_by_default: false,
        addresses_exported_by_default: false,
        raw_provider_errors_retained: false,
      },
      limitations: [
        "Production readiness applies only to the AWS-native and Amazon SES deployment described by this document.",
        "The product owner waived the incomplete 14-day and 1,000-message dogfood criterion on 2026-08-29 after 486 of 486 controlled deliveries with zero unexplained loss and zero duplicate terminal events; issue #105 preserves that decision and evidence.",
        "Each workload migration still requires a stream-specific canary and a rehearsed provider rollback before critical traffic moves.",
        "Amazon SES has no verified provider-side send idempotency key.",
        "AWS account quotas, sending access, and Region configuration remain customer responsibilities.",
      ],
    },
    AWS_RUNTIME_CAPABILITIES,
    AWS_SES_CAPABILITIES,
  ) satisfies DeploymentCapabilityDocument;
