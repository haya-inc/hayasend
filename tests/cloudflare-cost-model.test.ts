import { describe, expect, it } from "vitest";
import {
  estimateCloudflareCosts,
  PAID_RATES,
  PRICING_LAST_VERIFIED,
} from "../scripts/cloudflare-cost-model.mjs";

describe("Cloudflare observed cost model", () => {
  it("keeps the 1,000-message dogfood profile at the paid-plan minimum", () => {
    const estimate = estimateCloudflareCosts({ profile: "dogfood" });
    expect(PRICING_LAST_VERIFIED).toBe("2026-07-27");
    expect(estimate.monthly_usd).toBe(5);
    expect(estimate.components.email_messages.monthly_usd).toBe(0);
    expect(estimate.calculated_usage.email_messages).toBe(1_000);
    expect(estimate.provider_maturity).toBe("beta");
  });

  it("prices Email Sending above the current 3,000-message inclusion", () => {
    const estimate = estimateCloudflareCosts({
      profile: "dogfood",
      observed: { messages: 13_000 },
    });
    expect(estimate.components.email_messages.monthly_usd).toBe(3.5);
    expect(PAID_RATES.email_messages_per_thousand).toBe(0.35);
    expect(estimate.monthly_usd).toBe(8.5);
  });

  it("accepts observed hosted metrics without changing the model code", () => {
    const estimate = estimateCloudflareCosts({
      profile: "proof",
      observed: {
        messages: 100,
        average_worker_cpu_ms: 12.5,
        d1_rows_read_per_message: 55,
        d1_rows_written_per_message: 48,
      },
    });
    expect(estimate.observed_inputs).toMatchObject({
      messages: 100,
      average_worker_cpu_ms: 12.5,
      d1_rows_read_per_message: 55,
      d1_rows_written_per_message: 48,
    });
  });
});
