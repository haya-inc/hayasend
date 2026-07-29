import { runNeonBranch } from "./neon-branch.mjs";

const databaseUrl = await runNeonBranch("create", {
  writeEvidence: (serialized) => process.stderr.write(serialized),
});
if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
  throw new Error("Neon did not return a database credential.");
}
process.stdout.write(`${databaseUrl}\n`);
