export interface QueueDepth {
  visible: number;
  in_flight: number;
  delayed: number;
  total: number;
}

export interface QueueDiagnosticsSnapshot {
  provider: "memory" | "aws-sqs" | "postgresql";
  primary: QueueDepth;
  dead_letters: {
    delivery: QueueDepth | null;
    scheduler: QueueDepth | null;
    inbound: QueueDepth | null;
  };
}

export interface QueueDiagnostics {
  getQueueDiagnostics(): Promise<QueueDiagnosticsSnapshot>;
}
