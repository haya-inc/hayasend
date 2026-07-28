export interface JobWakeupPublisher {
  publish(): Promise<void>;
}

export interface JobWakeupWaiter {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
