import { emitOutboxMetrics } from "../core/metrics.js";
import {
  createAwsRuntime,
  type Runtime,
} from "../runtime.js";

let runtime: Runtime | undefined;

function getRuntime(): Runtime {
  runtime ??= createAwsRuntime();
  return runtime;
}

export async function runOutboxDispatcher(
  services: Pick<Runtime, "dispatchOutbox" | "getOutboxMetrics">,
  now = new Date(),
): Promise<void> {
  const sweep = await services.dispatchOutbox(now);
  const metrics = await services.getOutboxMetrics(now);
  emitOutboxMetrics(metrics, sweep.failed);
}

export async function handler(): Promise<void> {
  await runOutboxDispatcher(getRuntime());
}
