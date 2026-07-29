import type { LifecycleRuntime } from "./project-lifecycle.mjs";

export function runBlobStoreLifecycle(
  action: "create" | "verify" | "assert-empty" | "delete",
  options?: LifecycleRuntime,
): Promise<void>;
