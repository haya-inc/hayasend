import { describe, expect, it, vi } from "vitest";
import { runOutboxDispatcher } from "../src/aws/dispatcher.js";

describe("outbox dispatcher", () => {
  it("runs a bounded sweep and emits privacy-safe operational metrics", async () => {
    const dispatchOutbox = vi.fn(async () => ({
      leased: 4,
      dispatched: 3,
      failed: 1,
    }));
    const getOutboxMetrics = vi.fn(async () => ({
      due: 2,
      leased: 1,
      stuck_leases: 1,
      undispatched: 5,
      oldest_due_age_seconds: 480,
      publish_failures_total: 8,
      truncated: false,
    }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const now = new Date("2026-07-26T02:00:00.000Z");

    await runOutboxDispatcher(
      { dispatchOutbox, getOutboxMetrics },
      now,
    );

    expect(dispatchOutbox).toHaveBeenCalledWith(now);
    expect(getOutboxMetrics).toHaveBeenCalledWith(now);
    const metric = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(metric).toMatchObject({
      Service: "HayaSend",
      OutboxDue: 2,
      OutboxLeased: 1,
      OutboxStuckLeases: 1,
      OutboxUndispatched: 5,
      OutboxOldestDueAge: 480,
      OutboxDispatchFailures: 1,
      OutboxMetricsTruncated: 0,
    });
    expect(JSON.stringify(metric)).not.toMatch(
      /@|subject|body|recipient|message_id/i,
    );
  });
});
