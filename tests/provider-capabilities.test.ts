import { describe, expect, it } from "vitest";
import { AWS_SES_CAPABILITIES } from "../src/adapters/aws-ses-capabilities.js";
import { ACS_EMAIL_CAPABILITIES } from "../src/adapters/azure/acs-email-capabilities.js";
import { CLOUDFLARE_EMAIL_CAPABILITIES } from "../src/adapters/cloudflare/cloudflare-email-capabilities.js";
import { SENDGRID_EMAIL_CAPABILITIES } from "../src/adapters/sendgrid/sendgrid-email-capabilities.js";
import { CLOUDFLARE_EMAIL_CONFORMANCE_REPORT } from "../src/adapters/cloudflare/cloudflare-email-conformance.js";
import {
  CONFORMANCE_CASES,
  providerCapabilityDocumentSchema,
  validateConformanceResult,
  type ConformanceResult,
} from "../src/core/provider-capabilities.js";

function completeResult(
  overrides: Partial<ConformanceResult> = {},
): ConformanceResult {
  return {
    schema_version: "1.0.0",
    run_id: "run-test",
    provider: AWS_SES_CAPABILITIES.provider,
    adapter_version: AWS_SES_CAPABILITIES.adapter_version,
    capability_document_sha256: "0".repeat(64),
    started_at: "2026-07-26T00:00:00.000Z",
    completed_at: "2026-07-26T00:01:00.000Z",
    evidence_url: "https://github.com/haya-inc/hayasend/actions/runs/1",
    case_count: CONFORMANCE_CASES.length,
    summary: {
      passed: CONFORMANCE_CASES.length,
      failed: 0,
      unsupported: 0,
    },
    status: "passed",
    results: CONFORMANCE_CASES.map((testCase) => ({
      case_id: testCase.case_id,
      status: "passed",
      evidence_url: `https://github.com/haya-inc/hayasend/actions/runs/1#${testCase.case_id}`,
    })),
    ...overrides,
  };
}

describe("provider capability contract", () => {
  it("publishes current effective AWS SES limits and privacy defaults", () => {
    expect(
      providerCapabilityDocumentSchema.parse(AWS_SES_CAPABILITIES),
    ).toMatchObject({
      provider: "aws-ses",
      service_maturity: "beta",
      limits: {
        max_serialized_request_bytes: 9 * 1024 * 1024,
        max_mime_message_bytes: 39 * 1024 * 1024,
        max_combined_recipients: 50,
        max_attachments: 20,
        max_decoded_attachment_bytes: 25 * 1024 * 1024,
        max_batch_messages: 100,
        max_schedule_delay_seconds: 30 * 86_400,
      },
      privacy: {
        content_exported_by_default: false,
        addresses_exported_by_default: false,
        raw_provider_errors_retained: false,
      },
    });
    expect(AWS_SES_CAPABILITIES.features.provider_event_id.status).toBe(
      "supported",
    );
    expect(AWS_SES_CAPABILITIES.features.provider_idempotency.status).toBe(
      "unsupported",
    );
  });

  it("keeps conformance case identities unique and privacy-safe", () => {
    const caseIds = CONFORMANCE_CASES.map((testCase) => testCase.case_id);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    const serialized = JSON.stringify({
      capabilities: AWS_SES_CAPABILITIES,
      cases: CONFORMANCE_CASES,
    });
    expect(serialized).not.toMatch(
      /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|re_[A-Za-z0-9_-]{8,})/i,
    );
  });

  it("publishes honest Cloudflare Beta limits and capability gaps", () => {
    expect(CLOUDFLARE_EMAIL_CAPABILITIES).toMatchObject({
      provider: "cloudflare-email",
      service_maturity: "beta",
      limits: {
        max_mime_message_bytes: 5 * 1024 * 1024,
        max_combined_recipients: 50,
        max_attachments: 20,
      },
      features: {
        provider_message_id: { status: "supported" },
        provider_event_id: { status: "supported" },
        provider_idempotency: { status: "unsupported" },
      },
      events: {
        delivered: { status: "supported" },
        delayed: { status: "supported" },
        bounced: { status: "supported" },
        complained: { status: "supported" },
        rejected: { status: "supported" },
        opened: { status: "unsupported" },
        clicked: { status: "unsupported" },
      },
    });
    expect(CLOUDFLARE_EMAIL_CONFORMANCE_REPORT).toMatchObject({
      provider: "cloudflare-email",
      status: "passed",
      summary: { failed: 0, unsupported: 3 },
    });
    expect(
      CLOUDFLARE_EMAIL_CONFORMANCE_REPORT.results.find(
        (result) => result.case_id === "deploy-interruption",
      ),
    ).toMatchObject({
      status: "passed",
      evidence_url: "https://github.com/haya-inc/hayasend/issues/104",
    });
    for (const caseId of [
      "scheduler-wakeup-loss",
      "long-delay-recovery",
    ]) {
      expect(
        CLOUDFLARE_EMAIL_CONFORMANCE_REPORT.results.find(
          (result) => result.case_id === caseId,
        ),
      ).toMatchObject({
        status: "passed",
        evidence_url: "https://github.com/haya-inc/hayasend/issues/132",
      });
    }
    expect(
      CLOUDFLARE_EMAIL_CONFORMANCE_REPORT.results.find(
        (result) => result.case_id === "backup-restore",
      ),
    ).toMatchObject({
      status: "passed",
      evidence_url:
        "https://github.com/haya-inc/hayasend/actions/runs/30350436333",
    });
  });

  it("publishes fail-closed ACS limits and recipient-event boundaries", () => {
    expect(ACS_EMAIL_CAPABILITIES).toMatchObject({
      provider: "azure-communication-services",
      service_maturity: "experimental",
      limits: {
        max_serialized_request_bytes: 10_000_000,
        max_combined_recipients: 50,
        max_decoded_attachment_bytes: 7_500_000,
      },
      features: {
        provider_message_id: { status: "supported" },
        provider_event_id: { status: "supported" },
        provider_idempotency: { status: "unsupported" },
        domain_verification: { status: "conditional" },
      },
      events: {
        delivered: { status: "supported" },
        bounced: { status: "supported" },
        complained: { status: "unsupported" },
        opened: { status: "conditional" },
        clicked: { status: "conditional" },
      },
    });
  });

  it("publishes fail-closed SendGrid limits, signed events, and privacy boundaries", () => {
    expect(SENDGRID_EMAIL_CAPABILITIES).toMatchObject({
      provider: "sendgrid",
      service_maturity: "experimental",
      limits: {
        max_serialized_request_bytes: 29_999_999,
        max_mime_message_bytes: 30_000_000,
        max_combined_recipients: 1_000,
        max_decoded_attachment_bytes: 20_000_000,
      },
      features: {
        provider_message_id: { status: "conditional" },
        provider_event_id: { status: "supported" },
        provider_idempotency: { status: "unsupported" },
        domain_verification: { status: "supported" },
      },
      events: {
        accepted: { status: "supported" },
        delivered: { status: "supported" },
        delayed: { status: "supported" },
        bounced: { status: "supported" },
        complained: { status: "supported" },
        rejected: { status: "supported" },
        opened: { status: "conditional" },
        clicked: { status: "conditional" },
      },
      privacy: {
        content_exported_by_default: false,
        addresses_exported_by_default: false,
        raw_provider_errors_retained: false,
      },
    });
  });

  it("accepts a complete conformance report with consistent totals", () => {
    expect(
      validateConformanceResult(
        completeResult(),
        AWS_SES_CAPABILITIES,
        "0".repeat(64),
      ),
    ).toMatchObject({
      status: "passed",
      case_count: CONFORMANCE_CASES.length,
    });
  });

  it("rejects unsupported core invariants and inconsistent summaries", () => {
    const unsupportedResults = completeResult().results.map(
      (caseResult, index) =>
        index === 0
          ? {
              ...caseResult,
              status: "unsupported" as const,
              reason: "Not implemented.",
              capability_path: "features.provider_event_id.status",
            }
          : caseResult,
    );
    expect(() =>
      validateConformanceResult(
        completeResult({
          results: unsupportedResults,
          summary: {
            passed: CONFORMANCE_CASES.length - 1,
            failed: 0,
            unsupported: 1,
          },
        }),
        AWS_SES_CAPABILITIES,
      ),
    ).toThrow("Required conformance case cannot be unsupported");
    expect(() =>
      validateConformanceResult(
        completeResult({
          summary: { passed: 0, failed: 0, unsupported: 0 },
        }),
        AWS_SES_CAPABILITIES,
      ),
    ).toThrow("summary does not match");
  });

  it("binds a report to one capability document and chronological run", () => {
    expect(() =>
      validateConformanceResult(
        completeResult({ provider: "another-provider" }),
        AWS_SES_CAPABILITIES,
      ),
    ).toThrow("does not match its capability document");
    expect(() =>
      validateConformanceResult(
        completeResult(),
        AWS_SES_CAPABILITIES,
        "f".repeat(64),
      ),
    ).toThrow("capability digest does not match");
    expect(() =>
      validateConformanceResult(
        completeResult({
          started_at: "2026-07-26T00:02:00.000Z",
          completed_at: "2026-07-26T00:01:00.000Z",
        }),
        AWS_SES_CAPABILITIES,
      ),
    ).toThrow("cannot complete before");
  });
});
