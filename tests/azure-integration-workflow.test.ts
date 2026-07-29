import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Azure hosted lifecycle workflow", () => {
  it("uses OIDC, isolated ACS prerequisites, two proofs, rollback, and guarded cleanup", async () => {
    const [workflow, cleanup, eventGrid, locals] = await Promise.all([
      readFile(
        new URL(
          "../.github/workflows/azure-integration.yml",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../deploy/azure-container-apps/cleanup.sh",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../deploy/azure-container-apps/event-grid.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../deploy/azure-container-apps/locals.tf",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(workflow).toContain("environment: azure-integration");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain(
      '[[ "${GITHUB_REF_PROTECTED:-false}" != "true" ]]',
    );
    expect(workflow).toContain(
      '[[ "$AZURE_TEST_COST_CEILING_USD" != "100" ]]',
    );
    expect(workflow).toContain(
      '[[ "$AZURE_TEST_DURATION_MINUTES" != "120" ]]',
    );
    expect(workflow).toContain(
      "azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43",
    );
    expect(workflow).not.toContain("client-secret:");
    expect(workflow).not.toContain("AZURE_CREDENTIALS");
    expect(workflow).not.toContain("connection-string");
    expect(workflow).toContain(
      "TF_VAR_enable_hosted_proof_job: \"true\"",
    );
    expect(workflow).toContain(
      "deploy/azure-container-apps/verify-acs-prerequisites.sh",
    );
    expect(workflow).toContain(
      "scripts/extract-portable-hosted-proof.mjs",
    );
    expect(workflow).toContain(
      "scripts/azure-terminal-delivery.mjs",
    );
    expect(workflow).toContain(
      ".recipient_statuses == [\"delivered\", \"delivered\"]",
    );
    expect(workflow).toContain(
      "deploy/azure-container-apps/rollback.sh",
    );
    expect(workflow).toContain(
      "deploy/azure-container-apps/cleanup.sh",
    );
    expect(workflow).toContain(
      "HAYASEND_AZURE_ALLOW_PARTIAL: \"true\"",
    );
    expect(workflow).toContain(
      "steps.inventory_guard.outputs.validated == 'true'",
    );
    expect(workflow).toContain(
      "ghcr.io/haya-inc/hayasend@sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979",
    );
    expect(workflow).toContain(
      "ghcr.io/haya-inc/hayasend@sha256:458e9299ddef7a0d398e51cc18ce0daae2557cd444af55dadc67ae3e10bea519",
    );
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /actions\/upload-artifact@[0-9a-f]{40}/,
    );
    expect(cleanup).not.toContain(
      "terraform apply -input=false",
    );
    expect(cleanup).toContain(
      "terraform destroy -input=false",
    );
    expect(cleanup).toContain(
      'HAYASEND_AZURE_ALLOW_PARTIAL:-',
    );
    expect(cleanup).toContain(
      'az keyvault purge \\',
    );
    expect(cleanup).toContain(
      'az role definition list \\',
    );
    expect(eventGrid).toContain(
      "const config = inputs(false, false);",
    );
    expect(locals).toContain(
      'HAYASEND_RUNTIME_PROFILE           = "portable-postgres"',
    );
    expect(locals).toContain(
      'HAYASEND_DEPLOYMENT_PROFILE        = "azure-container-apps-acs"',
    );
  });
});
