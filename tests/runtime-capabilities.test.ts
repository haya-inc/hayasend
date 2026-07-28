import { describe, expect, it } from "vitest";
import { AWS_RUNTIME_CAPABILITIES } from "../src/adapters/aws-runtime-capabilities.js";
import { AWS_SES_CAPABILITIES } from "../src/adapters/aws-ses-capabilities.js";
import { CLOUDFLARE_EMAIL_CAPABILITIES } from "../src/adapters/cloudflare/cloudflare-email-capabilities.js";
import { CLOUDFLARE_RUNTIME_CAPABILITIES } from "../src/adapters/cloudflare-runtime-capabilities.js";
import { PORTABLE_RUNTIME_CAPABILITIES } from "../src/adapters/portable-runtime-capabilities.js";
import { VERCEL_RUNTIME_CAPABILITIES } from "../src/adapters/vercel-runtime-capabilities.js";
import {
  buildReadinessMatrix,
  readinessMatrixSchema,
  runtimeCapabilityDocumentSchema,
  validateDeploymentCapabilityDocument,
} from "../src/core/runtime-capabilities.js";
import { AWS_SES_DEPLOYMENT_CAPABILITIES } from "../src/deployments/aws-ses-capabilities.js";
import { CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES } from "../src/deployments/cloudflare-email-capabilities.js";

describe("runtime and deployment capability contracts", () => {
  it("publishes durable-store authority and private runtime defaults", () => {
    for (const runtime of [
      AWS_RUNTIME_CAPABILITIES,
      CLOUDFLARE_RUNTIME_CAPABILITIES,
    ]) {
      expect(runtimeCapabilityDocumentSchema.parse(runtime)).toMatchObject({
        service_maturity: "beta",
        authority: {
          durable_store: "metadata-ledger-outbox",
          atomic_message_outbox_commit: true,
          queue_is_source_of_truth: false,
          scheduler_is_source_of_truth: false,
          due_row_reconciliation: true,
        },
        privacy: {
          content_stored_in_customer_account: true,
          management_plane_content_exported_by_default: false,
          addresses_exported_by_default: false,
          raw_operational_errors_retained: false,
        },
      });
    }
  });

  it("keeps the portable runtime experimental while Cloud Run evidence is pending", () => {
    expect(
      runtimeCapabilityDocumentSchema.parse(
        PORTABLE_RUNTIME_CAPABILITIES,
      ),
    ).toMatchObject({
      runtime: "portable-postgres",
      service_maturity: "experimental",
      runtime_class: "portable-container",
      components: {
        atomic_store: { status: "supported" },
        payload_store: { status: "supported" },
        secret_injection: { status: "supported" },
        provider_event_ingress: { status: "conditional" },
        backup_restore: { status: "unsupported" },
      },
      lifecycle: {
        safe_deploy: { status: "conditional" },
        cleanup: { status: "unsupported" },
      },
    });
  });

  it("keeps Vercel experimental with PostgreSQL as scheduling authority", () => {
    expect(
      runtimeCapabilityDocumentSchema.parse(
        VERCEL_RUNTIME_CAPABILITIES,
      ),
    ).toMatchObject({
      runtime: "vercel-serverless",
      service_maturity: "experimental",
      runtime_class: "serverless",
      limits: {
        max_payload_bytes: 4_500_000,
        max_schedule_delay_seconds: 2_592_000,
        reconciliation_interval_seconds: 60,
      },
      authority: {
        queue_is_source_of_truth: false,
        scheduler_is_source_of_truth: false,
        due_row_reconciliation: true,
      },
      components: {
        payload_store: { status: "supported" },
        queue_wakeup: { status: "conditional" },
        scheduler_wakeup: { status: "supported" },
        backup_restore: { status: "unsupported" },
      },
    });
  });

  it("binds current deployments to separate runtime and transport documents", () => {
    expect(AWS_SES_DEPLOYMENT_CAPABILITIES).toMatchObject({
      deployment: "aws-ses",
      runtime: { profile: "aws-native" },
      transport: { provider: "aws-ses" },
      maturity: {
        runtime: "beta",
        transport: "beta",
        combination: "beta",
      },
      production_ready: false,
      evidence: {
        terminal_delivery: { status: "pending" },
        controlled_receipt: { status: "pending" },
      },
    });
    expect(CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES).toMatchObject({
      deployment: "cloudflare-email",
      runtime: { profile: "cloudflare-native" },
      transport: { provider: "cloudflare-email" },
      maturity: {
        runtime: "beta",
        transport: "beta",
        combination: "beta",
      },
      production_ready: false,
      evidence: {
        conformance: { status: "pending" },
        terminal_delivery: { status: "pending" },
        controlled_receipt: { status: "pending" },
      },
    });
  });

  it("generates a sorted readiness matrix with evidence blockers", () => {
    const matrix = buildReadinessMatrix([
      CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES,
      AWS_SES_DEPLOYMENT_CAPABILITIES,
    ]);

    expect(readinessMatrixSchema.parse(matrix)).toMatchObject({
      schema_version: "1.0.0",
      deployments: [
        {
          deployment: "aws-ses",
          production_ready: false,
          blockers: [
            "conformance",
            "terminal_delivery",
            "controlled_receipt",
          ],
        },
        {
          deployment: "cloudflare-email",
          production_ready: false,
          blockers: [
            "conformance",
            "terminal_delivery",
            "controlled_receipt",
          ],
        },
      ],
    });
  });

  it("rejects readiness blockers that drift from their evidence gates", () => {
    const matrix = buildReadinessMatrix([
      AWS_SES_DEPLOYMENT_CAPABILITIES,
    ]);
    expect(() =>
      readinessMatrixSchema.parse({
        ...matrix,
        deployments: matrix.deployments.map((deployment) => ({
          ...deployment,
          blockers: [],
        })),
      }),
    ).toThrow(
      "readiness blockers must exactly match non-passed evidence gates",
    );
  });

  it("rejects component identity, maturity, and limit drift", () => {
    expect(() =>
      validateDeploymentCapabilityDocument(
        {
          ...AWS_SES_DEPLOYMENT_CAPABILITIES,
          runtime: {
            ...AWS_SES_DEPLOYMENT_CAPABILITIES.runtime,
            profile: "another-runtime",
          },
        },
        AWS_RUNTIME_CAPABILITIES,
        AWS_SES_CAPABILITIES,
      ),
    ).toThrow("runtime identity does not match");

    expect(() =>
      validateDeploymentCapabilityDocument(
        {
          ...AWS_SES_DEPLOYMENT_CAPABILITIES,
          maturity: {
            ...AWS_SES_DEPLOYMENT_CAPABILITIES.maturity,
            combination: "production",
          },
        },
        AWS_RUNTIME_CAPABILITIES,
        AWS_SES_CAPABILITIES,
      ),
    ).toThrow("cannot exceed its weakest component");

    expect(() =>
      validateDeploymentCapabilityDocument(
        {
          ...CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES,
          effective_limits: {
            ...CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES.effective_limits,
            max_mime_message_bytes:
              CLOUDFLARE_EMAIL_CAPABILITIES.limits.max_mime_message_bytes + 1,
          },
        },
        CLOUDFLARE_RUNTIME_CAPABILITIES,
        CLOUDFLARE_EMAIL_CAPABILITIES,
      ),
    ).toThrow("message limit exceeds");
  });

  it("requires every evidence gate before production readiness", () => {
    expect(() =>
      validateDeploymentCapabilityDocument(
        {
          ...AWS_SES_DEPLOYMENT_CAPABILITIES,
          production_ready: true,
        },
        AWS_RUNTIME_CAPABILITIES,
        AWS_SES_CAPABILITIES,
      ),
    ).toThrow("production combination maturity");

    const productionRuntime = {
      ...AWS_RUNTIME_CAPABILITIES,
      service_maturity: "production" as const,
    };
    const productionTransport = {
      ...AWS_SES_CAPABILITIES,
      service_maturity: "production" as const,
    };
    expect(() =>
      validateDeploymentCapabilityDocument(
        {
          ...AWS_SES_DEPLOYMENT_CAPABILITIES,
          production_ready: true,
          maturity: {
            runtime: "production",
            transport: "production",
            combination: "production",
          },
        },
        productionRuntime,
        productionTransport,
      ),
    ).toThrow("requires passed conformance evidence");
  });

  it("keeps published documents free of obvious private values", () => {
    const serialized = JSON.stringify([
      AWS_RUNTIME_CAPABILITIES,
      CLOUDFLARE_RUNTIME_CAPABILITIES,
      PORTABLE_RUNTIME_CAPABILITIES,
      VERCEL_RUNTIME_CAPABILITIES,
      AWS_SES_DEPLOYMENT_CAPABILITIES,
      CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES,
    ]);
    expect(serialized).not.toMatch(
      /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|re_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})/i,
    );
  });
});
