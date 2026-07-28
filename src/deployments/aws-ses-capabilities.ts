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
      checked_at: "2026-07-28",
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
        combination: "beta",
      },
      production_ready: false,
      effective_limits: AWS_SES_CAPABILITIES.limits,
      evidence: {
        conformance: {
          status: "pending",
          url: "https://github.com/haya-inc/hayasend/issues/126",
          notes:
            "Exact-main hosted conformance and provider terminal proof are tracked in issue #126.",
        },
        lifecycle: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/22",
          notes:
            "The v0.1 release gate proved protected deployment, rollback behavior, and release verification.",
        },
        terminal_delivery: {
          status: "pending",
          url: "https://github.com/haya-inc/hayasend/issues/126",
          notes:
            "SES acceptance, SNS terminal correlation, and recipient convergence have not yet passed on exact main.",
        },
        controlled_receipt: {
          status: "pending",
          url: "https://github.com/haya-inc/hayasend/issues/126",
          notes:
            "Controlled mailbox receipt remains part of the terminal-delivery proof.",
        },
        cleanup: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/22",
          notes:
            "The reusable dedicated test-account integration verified stack cleanup with retain_stack=false.",
        },
      },
      privacy: {
        customer_owned_data_plane: true,
        management_plane_content_exported_by_default: false,
        addresses_exported_by_default: false,
        raw_provider_errors_retained: false,
      },
      limitations: [
        "Production readiness is false while issue #126 remains incomplete.",
        "Amazon SES has no verified provider-side send idempotency key.",
        "AWS account quotas, sending access, and Region configuration remain customer responsibilities.",
      ],
    },
    AWS_RUNTIME_CAPABILITIES,
    AWS_SES_CAPABILITIES,
  ) satisfies DeploymentCapabilityDocument;
