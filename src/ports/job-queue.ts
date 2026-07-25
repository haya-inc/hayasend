import type { Job } from "../core/types.js";

export interface JobQueue {
  enqueue(job: Job, delaySeconds?: number): Promise<void>;
}
