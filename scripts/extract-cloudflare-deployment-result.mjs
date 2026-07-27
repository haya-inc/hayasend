#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const path = argument("file");
const githubEnv = argument("github-env");
const prefix = argument("prefix") ?? "";
const workersSubdomain = argument("workers-subdomain");

if (!path || !githubEnv) {
  throw new Error("--file and --github-env are required.");
}

const content = await readFile(path, "utf8");
const marker = '{\n  "object": "cloudflare_deployment_result"';
const offset = content.lastIndexOf(marker);
if (offset < 0) {
  throw new Error("Cloudflare deployment result was not found.");
}
const result = JSON.parse(content.slice(offset));
if (
  typeof result.version_id !== "string" ||
  typeof result.database_id !== "string" ||
  typeof result.resources?.worker !== "string"
) {
  throw new Error("Cloudflare deployment result is incomplete.");
}
const reportedTarget = Array.isArray(result.targets)
  ? result.targets.find((target) => typeof target === "string")
  : undefined;
const endpoint =
  reportedTarget ??
  (workersSubdomain
    ? `https://${result.resources.worker}.${workersSubdomain}.workers.dev`
    : undefined);
if (!endpoint) {
  throw new Error(
    "Wrangler did not report an endpoint and no Workers subdomain was supplied.",
  );
}
const lines = [
  `${prefix}CF_VERSION_ID=${result.version_id}`,
  `${prefix}CF_DATABASE_ID=${result.database_id}`,
  `${prefix}CF_ENDPOINT=${endpoint}`,
];
await appendFile(githubEnv, `${lines.join("\n")}\n`, "utf8");
console.log(
  JSON.stringify({
    object: "cloudflare_deployment_result_summary",
    version_id: result.version_id,
    database_id: result.database_id,
    endpoint,
  }),
);
