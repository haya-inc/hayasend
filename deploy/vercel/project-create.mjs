import { runProjectLifecycle } from "./project-lifecycle.mjs";

const projectId = await runProjectLifecycle("create", {
  writeEvidence: (serialized) => process.stderr.write(serialized),
});
if (!/^prj_[A-Za-z0-9]{8,64}$/.test(projectId ?? "")) {
  throw new Error("Vercel did not return a valid project ID.");
}
process.stdout.write(`${projectId}\n`);
