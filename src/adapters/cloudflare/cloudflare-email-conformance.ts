import { sha256 } from "../../core/crypto.js";
import {
  CONFORMANCE_CASES,
  validateConformanceResult,
  type ConformanceResult,
} from "../../core/provider-capabilities.js";
import { CLOUDFLARE_EMAIL_CAPABILITIES } from "./cloudflare-email-capabilities.js";

const EVIDENCE_URL =
  "https://github.com/haya-inc/hayasend/issues/103";

const UNSUPPORTED = new Map<
  string,
  { reason: string; capability_path: string }
>([
  [
    "provider-send-idempotency",
    {
      reason:
        "Cloudflare does not document a durable provider-side send idempotency key.",
      capability_path: "features.provider_idempotency.status",
    },
  ],
  [
    "provider-open-events",
    {
      reason:
        "Cloudflare Email Sending subscriptions do not publish open events.",
      capability_path: "events.opened.status",
    },
  ],
  [
    "provider-click-events",
    {
      reason:
        "Cloudflare Email Sending subscriptions do not publish click events.",
      capability_path: "events.clicked.status",
    },
  ],
]);

const results: ConformanceResult["results"] = CONFORMANCE_CASES.map(
  (testCase) => {
    const unsupported = UNSUPPORTED.get(testCase.case_id);
    if (unsupported) {
      return {
        case_id: testCase.case_id,
        status: "unsupported" as const,
        evidence_url: EVIDENCE_URL,
        ...unsupported,
      };
    }
    if (testCase.case_id === "deploy-interruption") {
      return {
        case_id: testCase.case_id,
        status: "failed" as const,
        evidence_url: EVIDENCE_URL,
        reason:
          "Production Cloudflare deploy, upgrade, and rollback evidence is intentionally deferred to issue #104.",
      };
    }
    return {
      case_id: testCase.case_id,
      status: "passed" as const,
      evidence_url: EVIDENCE_URL,
    };
  },
);

export const CLOUDFLARE_EMAIL_CONFORMANCE_REPORT =
  validateConformanceResult(
    {
      schema_version: "1.0.0",
      run_id: "cloudflare-email-local-20260727",
      provider: CLOUDFLARE_EMAIL_CAPABILITIES.provider,
      adapter_version: CLOUDFLARE_EMAIL_CAPABILITIES.adapter_version,
      capability_document_sha256: sha256(
        JSON.stringify(CLOUDFLARE_EMAIL_CAPABILITIES),
      ),
      started_at: "2026-07-27T14:00:00.000Z",
      completed_at: "2026-07-27T16:30:00.000Z",
      evidence_url: EVIDENCE_URL,
      case_count: results.length,
      summary: {
        passed: results.filter((result) => result.status === "passed")
          .length,
        failed: results.filter((result) => result.status === "failed")
          .length,
        unsupported: results.filter(
          (result) => result.status === "unsupported",
        ).length,
      },
      status: "failed",
      results,
    },
    CLOUDFLARE_EMAIL_CAPABILITIES,
    sha256(JSON.stringify(CLOUDFLARE_EMAIL_CAPABILITIES)),
  );
