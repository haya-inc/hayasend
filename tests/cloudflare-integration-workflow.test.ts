import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Cloudflare hosted lifecycle workflow", () => {
  it("pins tools and fails closed around account confirmation and cleanup", async () => {
    const workflow = await readFile(
      new URL(
        "../.github/workflows/cloudflare-integration.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("environment: cloudflare-integration");
    expect(workflow).toContain(
      'CLOUDFLARE_TEST_ACCOUNT_KIND" != "general-purpose-test"',
    );
    expect(workflow).toContain(
      "Verify isolated resource namespace is unused",
    );
    expect(workflow).toContain(
      "steps.account_guard.outputs.validated == 'true'",
    );
    expect(workflow).toContain(
      '--confirm-account "$CLOUDFLARE_TEST_ACCOUNT_ID"',
    );
    expect(workflow).toContain(
      '--allowed-recipient "$CLOUDFLARE_TEST_TO"',
    );
    expect(workflow).toContain('CF_ENDPOINT="$INITIAL_CF_ENDPOINT"');
    expect(workflow).toContain("for attempt_number in $(seq 1 30)");
    expect(workflow).toContain(
      'test "$failure_http_code" = "503"',
    );
    expect(workflow).toContain(
      '--version-id "$INITIAL_CF_VERSION_ID"',
    );
    expect(workflow).toContain("code: 10007");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).toContain("wrangler@4.114.0");
    expect(workflow).toContain("node-version: 26.5.0");
    expect(workflow).toContain("npm@12.0.1");

    const apiProof = await readFile(
      new URL(
        "../scripts/cloudflare-integration-api.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(apiProof).toContain(
      "idempotencyKey: `hayasend-cloudflare-integration-${runId}`",
    );
    expect(apiProof).toContain(
      "transientStatusCodes.has(error.statusCode)",
    );
  });
});
