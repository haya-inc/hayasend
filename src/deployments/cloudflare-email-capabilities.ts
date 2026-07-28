import { CLOUDFLARE_EMAIL_CAPABILITIES } from "../adapters/cloudflare/cloudflare-email-capabilities.js";
import { CLOUDFLARE_RUNTIME_CAPABILITIES } from "../adapters/cloudflare-runtime-capabilities.js";
import {
  validateDeploymentCapabilityDocument,
  type DeploymentCapabilityDocument,
} from "../core/runtime-capabilities.js";
import { HAYASEND_VERSION } from "../version.js";

export const CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES =
  validateDeploymentCapabilityDocument(
    {
      schema_version: "1.0.0",
      deployment: "cloudflare-email",
      adapter_version: HAYASEND_VERSION,
      checked_at: "2026-07-28",
      runtime: {
        profile: CLOUDFLARE_RUNTIME_CAPABILITIES.runtime,
        adapter_version: CLOUDFLARE_RUNTIME_CAPABILITIES.adapter_version,
        capability_document:
          "conformance/runtimes/cloudflare-native.v1.json",
      },
      transport: {
        provider: CLOUDFLARE_EMAIL_CAPABILITIES.provider,
        adapter_version: CLOUDFLARE_EMAIL_CAPABILITIES.adapter_version,
        capability_document:
          "conformance/providers/cloudflare-email.v1.json",
      },
      maturity: {
        runtime: CLOUDFLARE_RUNTIME_CAPABILITIES.service_maturity,
        transport: CLOUDFLARE_EMAIL_CAPABILITIES.service_maturity,
        combination: "beta",
      },
      production_ready: false,
      effective_limits: CLOUDFLARE_EMAIL_CAPABILITIES.limits,
      evidence: {
        conformance: {
          status: "pending",
          url: "https://github.com/haya-inc/hayasend/issues/122",
          notes:
            "The shared catalog and hosted lifecycle pass, but the exact combination remains incomplete until terminal-event convergence is proven.",
        },
        lifecycle: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/104",
          notes:
            "The protected hosted workflow proved deploy, doctor, controlled failure, upgrade, rollback, and cleanup.",
        },
        terminal_delivery: {
          status: "pending",
          url: "https://github.com/haya-inc/hayasend/issues/122",
          notes:
            "Provider acceptance has not yet produced the required terminal delivery event.",
        },
        controlled_receipt: {
          status: "pending",
          url: "https://github.com/haya-inc/hayasend/issues/122",
          notes:
            "The uniquely identified message has not yet been confirmed in the controlled mailbox.",
        },
        cleanup: {
          status: "passed",
          url: "https://github.com/haya-inc/hayasend/issues/104",
          notes:
            "The hosted lifecycle proof removed the isolated Worker, D1, R2, and Queue resources and verified absence.",
        },
      },
      privacy: {
        customer_owned_data_plane: true,
        management_plane_content_exported_by_default: false,
        addresses_exported_by_default: false,
        raw_provider_errors_retained: false,
      },
      limitations: [
        "Cloudflare Email Service and this deployment combination remain Beta.",
        "Production readiness is false while issue #122 remains incomplete.",
        "The current Cloudflare runtime exposes a narrower product surface than the AWS runtime.",
      ],
    },
    CLOUDFLARE_RUNTIME_CAPABILITIES,
    CLOUDFLARE_EMAIL_CAPABILITIES,
  ) satisfies DeploymentCapabilityDocument;
