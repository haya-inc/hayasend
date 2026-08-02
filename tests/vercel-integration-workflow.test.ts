import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Vercel hosted lifecycle workflow", () => {
  it("uses isolated Vercel and Neon resources, exact versions, rollback, and ordered cleanup", async () => {
    const [workflow, library, rollback] = await Promise.all([
      readFile(
        new URL(
          "../.github/workflows/vercel-integration.yml",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../deploy/vercel/lib.sh", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/vercel/rollback.sh", import.meta.url),
        "utf8",
      ),
    ]);

    expect(workflow).toContain("environment: vercel-integration");
    expect(workflow).toContain(
      'if [[ "$GITHUB_REF" != "refs/heads/main" ]]',
    );
    expect(workflow).toContain(
      '[[ "${GITHUB_REF_PROTECTED:-false}" != "true" ]]',
    );
    expect(workflow).toContain(
      '[[ "$VERCEL_TEST_ACCOUNT_KIND" != "general-purpose-test" ]]',
    );
    expect(workflow).toContain(
      '[[ "$NEON_TEST_ACCOUNT_KIND" != "general-purpose-test" ]]',
    );
    expect(workflow).toContain(
      '[[ "$VERCEL_TEST_COST_CEILING_USD" != "50" ]]',
    );
    expect(workflow).toContain(
      '[[ "$VERCEL_TEST_DURATION_MINUTES" != "90" ]]',
    );
    expect(workflow).toContain("VERCEL_CLI_VERSION: 58.1.0");
    expect(workflow).toContain(
      "VERCEL_CLI_INTEGRITY: sha512-IaveydZepbxIciXIskd032O31cVKjI+8YFD4Y9EuvNLNnIltsYL+0hE0AIhol5wEPDBGm3zKtYA8GKrQNAJ12w==",
    );
    expect(workflow).toContain("node-version: 24.18.1");
    expect(workflow).toContain("npm@12.0.2");
    expect(workflow).toContain(
      "ref: e6a4cdabe5e699bfd8fc509484e3ed14a00091da",
    );
    expect(workflow).toContain(
      '.version == "0.3.1"',
    );
    expect(workflow).toContain(
      '.version == "0.3.9"',
    );
    expect(workflow).toContain(
      "add_plain HAYASEND_RUNTIME_PROFILE vercel-serverless",
    );
    expect(workflow).toContain(
      "--env HAYASEND_RUNTIME_PROFILE=vercel-serverless",
    );

    const projectAttempt = workflow.indexOf(
      "Mark the external lifecycle as started",
    );
    const projectCreate = workflow.indexOf(
      "Create and verify one disposable Vercel project",
    );
    const blobAttempt = workflow.indexOf(
      "Mark the Blob lifecycle as started",
    );
    const blobCreate = workflow.indexOf(
      "Create and connect one production-only private Blob store",
    );
    const neonAttempt = workflow.indexOf(
      "Mark the Neon branch lifecycle as started",
    );
    const neonCreate = workflow.indexOf(
      "Create and verify one ephemeral Neon PostgreSQL 18 branch",
    );
    expect(projectAttempt).toBeGreaterThan(-1);
    expect(projectAttempt).toBeLessThan(projectCreate);
    expect(blobAttempt).toBeLessThan(blobCreate);
    expect(neonAttempt).toBeLessThan(neonCreate);

    expect(workflow).toContain(
      "scripts/vercel-blob-hosted-proof.mjs",
    );
    expect(workflow).toContain(
      ".checks.scheduled_horizon_seconds == 2592000",
    );
    expect(workflow).toContain(
      ".signed_put_bound_to_exact_object == true",
    );
    expect(workflow).toContain(
      ".public_read_refused == true",
    );
    expect(workflow).toContain(
      "HAYASEND_VERCEL_ROLLBACK_VERSION: 0.3.1",
    );
    expect(workflow).toContain(
      "node deploy/vercel/blob-store-assert-empty.mjs",
    );
    expect(workflow).toContain(
      "node deploy/vercel/blob-store-delete.mjs",
    );
    expect(workflow).toContain(
      "node deploy/vercel/neon-branch-delete.mjs",
    );
    expect(workflow).toContain(
      "node deploy/vercel/project-delete.mjs",
    );
    expect(workflow).toContain(
      "steps.blob_deleted.outputs.deleted == 'true'",
    );
    expect(library).toContain("ready_deployment_id()");
    expect(library).toContain(
      'test("^dpl_[A-Za-z0-9]+$")',
    );
    expect(rollback).toContain(
      'if [[ "$active_deployment_id" != "$rollback_deployment_id" ]]',
    );
    expect(workflow).not.toContain("SENDGRID_API_KEY");
    expect(workflow).not.toContain("AWS_ACCESS_KEY_ID");
    expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY");
    const artifactBlock = workflow.slice(
      workflow.indexOf("- name: Upload privacy-safe proof evidence"),
    );
    expect(artifactBlock).not.toContain(
      "${{ runner.temp }}/vercel-blob-token\n",
    );
    expect(artifactBlock).not.toContain(
      "${{ runner.temp }}/neon-database-url\n",
    );
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /actions\/setup-node@[0-9a-f]{40}/,
    );
    expect(workflow).toMatch(
      /actions\/upload-artifact@[0-9a-f]{40}/,
    );
  });
});
