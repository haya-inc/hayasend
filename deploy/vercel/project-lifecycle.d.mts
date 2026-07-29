export type LifecycleRuntime = {
  fetch?: typeof globalThis.fetch;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  writeEvidence?: (serialized: string) => void | Promise<void>;
};

export function runProjectLifecycle(
  action: "create" | "verify" | "delete",
  options?: LifecycleRuntime,
): Promise<string | undefined>;
