import type { OutboxMetrics } from "../ports/delivery-outbox-store.js";

export function emitCountMetric(name: string, value = 1): void {
  console.info(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "HayaSend",
            Dimensions: [["Service"]],
            Metrics: [{ Name: name, Unit: "Count" }],
          },
        ],
      },
      Service: "HayaSend",
      [name]: value,
    }),
  );
}

export function emitOutboxMetrics(
  metrics: OutboxMetrics,
  dispatchFailures: number,
): void {
  console.info(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "HayaSend",
            Dimensions: [["Service"]],
            Metrics: [
              { Name: "OutboxDue", Unit: "Count" },
              { Name: "OutboxLeased", Unit: "Count" },
              { Name: "OutboxStuckLeases", Unit: "Count" },
              { Name: "OutboxUndispatched", Unit: "Count" },
              { Name: "OutboxOldestDueAge", Unit: "Seconds" },
              { Name: "OutboxDispatchFailures", Unit: "Count" },
              { Name: "OutboxMetricsTruncated", Unit: "Count" },
            ],
          },
        ],
      },
      Service: "HayaSend",
      OutboxDue: metrics.due,
      OutboxLeased: metrics.leased,
      OutboxStuckLeases: metrics.stuck_leases,
      OutboxUndispatched: metrics.undispatched,
      OutboxOldestDueAge: metrics.oldest_due_age_seconds,
      OutboxDispatchFailures: dispatchFailures,
      OutboxMetricsTruncated: metrics.truncated ? 1 : 0,
    }),
  );
}
