import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const config = JSON.parse(
  await readFile(new URL("vercel.json", root), "utf8"),
);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const functionsSource = await readFile(
  new URL("src/vercel/functions.ts", root),
  "utf8",
);

assert.equal(config.$schema, "https://openapi.vercel.sh/vercel.json");
assert.equal(config.framework, "hono");
assert.equal(config.fluid, true);
assert.deepEqual(config.regions, ["hnd1"]);
assert.deepEqual(config.crons, [
  {
    path: "/api/reconcile",
    schedule: "* * * * *",
  },
]);

const application = config.functions?.["app.ts"];
assert.equal(application?.maxDuration, 60);
assert.equal(application?.supportsCancellation, true);

const queue = config.functions?.["api/queue.ts"];
assert.equal(queue?.maxDuration, 300);
assert.equal(queue?.supportsCancellation, true);
assert.deepEqual(queue?.experimentalTriggers, [
  {
    type: "queue/v2beta",
    topic: "hayasend-jobs-v1",
    retryAfterSeconds: 30,
    initialDelaySeconds: 0,
  },
]);

const reconciliation = config.functions?.["api/reconcile.ts"];
assert.equal(reconciliation?.maxDuration, 300);
assert.equal(reconciliation?.supportsCancellation, true);
assert.equal(config.rewrites, undefined);
assert.equal(config.routes, undefined);

assert.match(
  functionsSource,
  /VERCEL_QUEUE_TOPIC = "hayasend-jobs-v1"/,
);
assert.match(
  functionsSource,
  /VERCEL_QUEUE_RETENTION_SECONDS = 7 \* 24 \* 60 \* 60/,
);
assert.equal(packageJson.dependencies?.["@vercel/blob"], "2.6.1");
assert.equal(packageJson.dependencies?.["@vercel/functions"], "3.7.6");
assert.equal(packageJson.dependencies?.["@vercel/queue"], "0.4.0");

for (const path of ["app.ts", "api/queue.ts", "api/reconcile.ts"]) {
  const source = await readFile(new URL(path, root), "utf8");
  assert.doesNotMatch(source, /(?:token|secret|password)\s*[:=]\s*["'][^"']+/i);
}

const requiredCliVersion = (
  await readFile(
    new URL("deploy/vercel/.vercel-cli-version", root),
    "utf8",
  )
).trim();
const requiredCliIntegrity = (
  await readFile(
    new URL("deploy/vercel/.vercel-cli-integrity", root),
    "utf8",
  )
).trim();
assert.equal(requiredCliVersion, "58.1.0");
assert.equal(
  requiredCliIntegrity,
  "sha512-IaveydZepbxIciXIskd032O31cVKjI+8YFD4Y9EuvNLNnIltsYL+0hE0AIhol5wEPDBGm3zKtYA8GKrQNAJ12w==",
);

console.log(
  "Vercel Hono, Queues, Cron, private Blob, and pinned CLI configuration are internally consistent.",
);
