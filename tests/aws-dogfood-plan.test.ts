import { describe, expect, it } from "vitest";
import {
  DOGFOOD_EXPECTED_TOTAL,
  buildDogfoodMessage,
  durationSummary,
  planDogfoodRun,
  requireDogfoodRetryWindow,
} from "../scripts/aws-dogfood-plan.mjs";

describe("AWS dogfood campaign planning", () => {
  it("plans exactly 1,008 deterministic messages across 14 days", () => {
    expect(DOGFOOD_EXPECTED_TOTAL).toBe(1_008);
    const first = planDogfoodRun({
      startDate: "2026-08-02",
      runDate: "2026-08-02",
      slot: 0,
    });
    const last = planDogfoodRun({
      startDate: "2026-08-02",
      runDate: "2026-08-15",
      slot: 3,
    });
    expect(first).toMatchObject({
      active: true,
      day_number: 1,
      global_offset: 0,
      expected_total: 1_008,
    });
    expect(last).toMatchObject({
      active: true,
      day_number: 14,
      global_offset: 990,
      expected_total: 1_008,
    });
    expect(
      planDogfoodRun({
        startDate: "2026-08-02",
        runDate: "2026-08-16",
        slot: 0,
      }).active,
    ).toBe(false);
  });

  it("builds privacy-safe FolioMCP-shaped messages and stable keys", () => {
    const plan = planDogfoodRun({
      startDate: "2026-08-02",
      runDate: "2026-08-02",
      slot: 0,
      batchSize: 4,
    });
    const messages = Array.from({ length: 4 }, (_, index) =>
      buildDogfoodMessage(
        plan,
        index,
        "HayaSend <dogfood@example.com>",
        "controlled@example.net",
      ),
    );
    expect(messages.map((message) => message.notification_type)).toEqual([
      "pdf.completed",
      "pdf.failed",
      "sharing.created",
      "operations.quota_warning",
    ]);
    expect(messages[0]?.idempotency_key).toBe(
      "hayasend-dogfood-v1-2026-08-02-s0-01",
    );
    expect(messages[0]?.payload.text).toContain(
      "No customer or private content",
    );
    expect(messages[0]?.payload.subject).toBe(
      "[HayaSend Dogfood] PDF completed 2026-08-02 s0 #01",
    );
  });

  it("summarizes latency with nearest-rank percentiles", () => {
    expect(durationSummary([9, 1, 5, 3])).toEqual({
      count: 4,
      min_ms: 1,
      p50_ms: 3,
      p95_ms: 9,
      max_ms: 9,
    });
  });

  it("allows recovery only inside the 24-hour idempotency window", () => {
    const plan = planDogfoodRun({
      startDate: "2026-08-02",
      runDate: "2026-08-02",
      slot: 1,
    });
    expect(
      requireDogfoodRetryWindow(plan, new Date("2026-08-03T06:16:59.999Z")),
    ).toMatchObject({
      scheduled_at: "2026-08-02T06:17:00.000Z",
    });
    expect(() =>
      requireDogfoodRetryWindow(plan, new Date("2026-08-03T06:17:00.000Z")),
    ).toThrow("24-hour idempotency retry window");
    expect(() =>
      requireDogfoodRetryWindow(plan, new Date("2026-08-02T06:16:59.999Z")),
    ).toThrow("before its nominal UTC time");
  });
});
