import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Render hosted lifecycle workflow", () => {
  it("targets one exact project, runs a one-off proof, and deletes the whole project", async () => {
    const workflow = await readFile(
      new URL(
        "../.github/workflows/render-integration.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("environment: render-integration");
    expect(workflow).toContain(
      'if [[ "$GITHUB_REF" != "refs/heads/main" ]]',
    );
    expect(workflow).toContain(
      '[[ "${GITHUB_REF_PROTECTED:-false}" != "true" ]]',
    );
    expect(workflow).toContain(
      '${{ inputs.confirm_cost_ceiling_usd }}',
    );
    expect(workflow).toContain(
      '[[ "$RENDER_TEST_SERVICE_PLAN" != "starter" ]]',
    );
    expect(workflow).toContain(
      '[[ "$RENDER_TEST_POSTGRES_PLAN" != "basic-256mb" ]]',
    );
    expect(workflow).toContain(
      '[[ "$RENDER_TEST_COST_CEILING_USD" != "30" ]]',
    );
    expect(workflow).toContain("RENDER_CLI_VERSION: 2.22.0");
    expect(workflow).toContain(
      "RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}",
    );
    expect(workflow).toContain("deploy/render/verify-project.sh");
    expect(workflow).toContain("deploy/render/proof.sh");
    expect(workflow).toContain("deploy/render/cleanup-project.sh");
    expect(workflow).toContain(
      "HAYASEND_ALLOW_DESTROY: render-project",
    );
    expect(workflow).toContain(
      "steps.inventory_guard.outputs.validated == 'true'",
    );
    expect(workflow).toContain(
      "ghcr.io/haya-inc/hayasend@sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979",
    );
    expect(workflow).not.toContain("SENDGRID_API_KEY");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /actions\/upload-artifact@[0-9a-f]{40}/,
    );
  });
});
