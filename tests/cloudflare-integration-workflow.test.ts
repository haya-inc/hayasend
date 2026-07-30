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
    expect(workflow).toContain("Verify isolated resource namespace is unused");
    expect(workflow).toContain(
      "steps.account_guard.outputs.validated == 'true'",
    );
    expect(workflow).toContain(
      '--confirm-account "$CLOUDFLARE_TEST_ACCOUNT_ID"',
    );
    expect(workflow).toContain('--allowed-recipient "$CLOUDFLARE_TEST_TO"');
    expect(workflow).toContain('CF_ENDPOINT="$INITIAL_CF_ENDPOINT"');
    expect(workflow).toContain(
      "node scripts/cloudflare-backup-restore-seed.mjs",
    );
    expect(workflow).toContain(
      '$GITHUB_WORKSPACE/src/workers/cloudflare-backup-restore-probe.ts',
    );
    expect(workflow).toContain(
      '"wrangler@$WRANGLER_VERSION" d1 export',
    );
    expect(workflow).toContain(
      '.status == "passed" and',
    );
    expect(workflow).toContain(
      ".immutable_delivery_ledger_unchanged == true",
    );
    expect(workflow).toContain(
      ".external_send_performed_during_restore == false",
    );
    expect(workflow).toContain(
      '--name "$RESTORE_DEPLOYMENT_NAME"',
    );
    expect(workflow).toContain(
      "Restore Worker absence could not be verified.",
    );
    expect(workflow).toContain("for _ in $(seq 1 30)");
    expect(workflow).toContain('test "$failure_http_code" = "503"');
    expect(workflow).toContain('--version-id "$INITIAL_CF_VERSION_ID"');
    expect(workflow).toContain("code: 10007");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).toContain("WRANGLER_VERSION: 4.115.0");
    expect(workflow).toContain("wrangler@$WRANGLER_VERSION");
    expect(workflow).toContain("node-version: 26.5.0");
    expect(workflow).toContain("npm@12.0.2");

    const apiProof = await readFile(
      new URL("../scripts/cloudflare-integration-api.mjs", import.meta.url),
      "utf8",
    );
    expect(apiProof).toContain(
      "idempotencyKey: `hayasend-cloudflare-integration-${runId}`",
    );
    expect(apiProof).toContain("transientStatusCodes.has(error.statusCode)");
    expect(apiProof).toContain("const edgePropagationAttempts = 30");
    expect(apiProof).toContain("attempt < edgePropagationAttempts");
  });

  it("retains a two-phase namespace and requires terminal delivery evidence", async () => {
    const workflow = await readFile(
      new URL(
        "../.github/workflows/cloudflare-terminal-delivery.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("environment: cloudflare-integration");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).toContain(
      'test "${GITHUB_REF_PROTECTED:-false}" = "true"',
    );
    expect(workflow).toContain("Verify retained namespace is unused");
    expect(workflow).toContain(
      "npm run --silent cli -- doctor cloudflare-events",
    );
    expect(workflow).toContain("node scripts/cloudflare-terminal-delivery.mjs");
    expect(workflow).toContain('provider_type !== "delivered"');
    expect(workflow).toContain(
      "Expected exactly one terminal delivered provider event.",
    );
    expect(workflow).toContain(
      "always() && inputs.phase == 'verify-and-cleanup'",
    );
    expect(workflow).toContain("code: 10007");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).toContain("WRANGLER_VERSION: 4.115.0");
    expect(workflow).toContain("wrangler@$WRANGLER_VERSION");
    expect(workflow).toContain("node-version: 26.5.0");
    expect(workflow).toContain("npm@12.0.2");

    const proof = await readFile(
      new URL("../scripts/cloudflare-terminal-delivery.mjs", import.meta.url),
      "utf8",
    );
    expect(proof).toContain(
      "HayaSend Cloudflare terminal delivery ${runId}-${runAttempt}",
    );
    expect(proof).toContain(
      'recipientSummary.aggregate_status === "delivered"',
    );
    expect(proof).toContain(
      "Cloudflare remained provider-accepted without a delivered event",
    );
    expect(proof).toContain("signal: AbortSignal.timeout(sendTimeoutMs)");
    expect(proof).toContain("send_transient_failures");
    expect(proof).toContain("poll_transient_failures");
    expect(workflow).toContain("cloudflare-terminal-observations.jsonl");
    expect(proof).toContain(
      "idempotencyKey = `hayasend-cloudflare-terminal-${runId}-${runAttempt}`",
    );
  });
});
