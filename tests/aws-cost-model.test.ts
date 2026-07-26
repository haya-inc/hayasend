import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

async function estimate(...args: string[]) {
  const { stdout } = await run(
    process.execPath,
    ["scripts/aws-cost-model.mjs", ...args],
    {
      cwd: process.cwd(),
    },
  );
  return JSON.parse(stdout) as {
    pricing_last_verified: string;
    quantities: Record<string, number>;
    costs: {
      infrastructure_total_usd: number;
      estimated_total_usd: number;
      ses: { monthly_usd: number };
      lambda: { monthly_usd: number };
      cloudwatch: { monthly_usd: number };
    };
  };
}

describe("AWS cost model", () => {
  it("reproduces the light Virginia persistent-free-tier profile", async () => {
    const result = await estimate(
      "--profile",
      "light",
      "--region",
      "us-east-1",
      "--free-tier",
      "persistent",
      "--ses",
      "a-la-carte",
    );

    expect(result.pricing_last_verified).toBe("2026-07-26");
    expect(result.quantities.webhook_deliveries).toBe(5_000);
    expect(result.quantities.dispatcher_sweeps).toBe(43_200);
    expect(result.quantities.lambda_invocations).toBe(98_200);
    expect(result.costs.lambda.monthly_usd).toBe(0);
    expect(result.costs.cloudwatch.monthly_usd).toBe(0.1);
    expect(result.costs.ses.monthly_usd).toBe(1);
    expect(result.costs.infrastructure_total_usd).toBeCloseTo(0.316214, 6);
    expect(result.costs.estimated_total_usd).toBeCloseTo(1.316214, 6);
  });

  it("reproduces the representative Tokyo list-price profile", async () => {
    const result = await estimate(
      "--profile",
      "representative",
      "--region",
      "ap-northeast-1",
      "--free-tier",
      "none",
      "--ses",
      "essentials",
    );

    expect(result.quantities.webhook_deliveries).toBe(2_000_000);
    expect(result.quantities.lambda_invocations).toBe(7_043_200);
    expect(result.quantities.dynamodb_write_request_units).toBe(
      17_000_000,
    );
    expect(result.costs.ses.monthly_usd).toBe(160);
    expect(result.costs.infrastructure_total_usd).toBe(59.58039);
    expect(result.costs.estimated_total_usd).toBe(219.58039);
  });

  it("models attachment storage and SES data separately", async () => {
    const baseline = await estimate("--messages", "100000");
    const withAttachments = await estimate(
      "--messages",
      "100000",
      "--attachment-share",
      "0.1",
      "--attachment-mib",
      "1",
    );

    expect(baseline.quantities.attachment_storage_gib).toBe(0);
    expect(withAttachments.quantities.attachment_storage_gib).toBeCloseTo(
      9.765625,
    );
    expect(withAttachments.quantities.ses_attachment_data_gb).toBeCloseTo(
      10.48576,
    );
    expect(withAttachments.costs.ses.monthly_usd).toBeGreaterThan(
      baseline.costs.ses.monthly_usd,
    );
    expect(withAttachments.costs.infrastructure_total_usd).toBeGreaterThan(
      baseline.costs.infrastructure_total_usd,
    );
  });

  it("keeps the published example table aligned with calculator output", async () => {
    const docs = await readFile(
      new URL("../docs/aws-costs.md", import.meta.url),
      "utf8",
    );
    const cases = [
      ["light", "us-east-1", "10,000 messages"],
      ["light", "ap-northeast-1", "10,000 messages"],
      ["representative", "us-east-1", "1,000,000 messages"],
      [
        "representative",
        "ap-northeast-1",
        "1,000,000 messages",
      ],
    ] as const;

    for (const [profile, region, label] of cases) {
      const [list, free, essentials] = await Promise.all([
        estimate(
          "--profile",
          profile,
          "--region",
          region,
          "--free-tier",
          "none",
        ),
        estimate(
          "--profile",
          profile,
          "--region",
          region,
          "--free-tier",
          "persistent",
        ),
        estimate(
          "--profile",
          profile,
          "--region",
          region,
          "--free-tier",
          "persistent",
          "--ses",
          "essentials",
        ),
      ]);
      const money = (value: number) => `$${value.toFixed(2)}`;
      expect(docs).toContain(
        `| ${label} | \`${region}\` | ` +
          `${money(list.costs.infrastructure_total_usd)} | ` +
          `${money(free.costs.infrastructure_total_usd)} | ` +
          `${money(free.costs.ses.monthly_usd)} | ` +
          `${money(free.costs.estimated_total_usd)} | ` +
          `${money(essentials.costs.ses.monthly_usd)} | ` +
          `${money(essentials.costs.estimated_total_usd)} |`,
      );
    }
  });

  it("fails closed for unsupported regions and invalid ratios", async () => {
    await expect(
      run(
        process.execPath,
        ["scripts/aws-cost-model.mjs", "--region", "eu-west-1"],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      run(
        process.execPath,
        [
          "scripts/aws-cost-model.mjs",
          "--webhook-coverage",
          "1.1",
        ],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});
