#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const realNpmCli = process.env.HAYASEND_REAL_NPM_CLI;
if (!realNpmCli || !isAbsolute(realNpmCli)) {
  process.stderr.write(
    "HayaSend could not locate the absolute npm CLI used by AWS SAM.\n",
  );
  process.exit(127);
}

const args = process.argv
  .slice(2)
  .filter((argument) => argument !== "--unsafe-perm");
const result = spawnSync(process.execPath, [realNpmCli, ...args], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(127);
}
process.exit(result.status ?? 1);
