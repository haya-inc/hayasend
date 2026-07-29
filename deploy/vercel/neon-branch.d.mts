import type { LifecycleRuntime } from "./project-lifecycle.mjs";

export function runNeonBranch(
  action: "create" | "verify" | "delete",
  options?: LifecycleRuntime,
): Promise<string | undefined>;
