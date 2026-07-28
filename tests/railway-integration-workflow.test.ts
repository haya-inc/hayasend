import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Railway hosted lifecycle workflow", () => {
  it("is main-only, cost-guarded, console-only, and cleans up on failure", async () => {
    const workflow = await readFile(
      new URL(
        "../.github/workflows/railway-integration.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("environment: railway-integration");
    expect(workflow).toContain(
      'if [[ "$GITHUB_REF" != "refs/heads/main" ]]',
    );
    expect(workflow).toContain(
      '[[ "$RAILWAY_TEST_PLAN" != "hobby" ]]',
    );
    expect(workflow).toContain(
      '[[ "$RAILWAY_TEST_COMPUTE_HARD_LIMIT_USD" != "10" ]]',
    );
    expect(workflow).toContain(
      "RAILWAY_API_TOKEN: ${{ secrets.RAILWAY_API_TOKEN }}",
    );
    expect(workflow).toContain(
      "HAYASEND_RAILWAY_WORKSPACE_ID: ${{ vars.RAILWAY_TEST_WORKSPACE_ID }}",
    );
    expect(workflow).not.toContain("RAILWAY_TOKEN:");
    expect(workflow).toContain("HAYASEND_TRANSPORT: console");
    expect(workflow).not.toContain("SENDGRID_API_KEY");
    expect(workflow).toContain(
      "ghcr.io/haya-inc/hayasend@sha256:73c650a648824005adeb45cf6e5ef1ca8c7d9f321d25c5c58290c070ee6a8979",
    );
    expect(workflow).toContain("RAILWAY_CLI_VERSION: 5.30.1");
    expect(workflow).toContain(
      "Run the portable semantic proof inside Railway",
    );
    expect(workflow).toContain(
      "node dist/portable/hosted-proof.js",
    );
    expect(workflow).toContain(
      ".checks.scheduled_horizon_seconds == 2592000",
    );
    expect(workflow).toContain(
      "steps.inventory_guard.outputs.validated == 'true'",
    );
    expect(workflow).toContain(
      "HAYASEND_RAILWAY_ALLOW_PARTIAL: \"true\"",
    );
    expect(workflow).toContain("deploy/railway/cleanup.sh");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(
      /actions\/upload-artifact@[0-9a-f]{40}/,
    );
    expect(workflow).toContain("if-no-files-found: warn");
  });
});
