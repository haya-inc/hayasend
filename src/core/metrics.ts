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
