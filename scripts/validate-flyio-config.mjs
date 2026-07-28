import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const configUrl = new URL(
  "../deploy/flyio/fly.toml",
  import.meta.url,
);
const platformDigestUrl = new URL(
  "../deploy/flyio/.image-linux-amd64-sha256",
  import.meta.url,
);
const source = await readFile(configUrl, "utf8");
const platformDigest = (await readFile(platformDigestUrl, "utf8")).trim();
const expectedImage =
  "ghcr.io/haya-inc/hayasend@sha256:458e9299ddef7a0d398e51cc18ce0daae2557cd444af55dadc67ae3e10bea519";

assert.match(
  source,
  new RegExp(
    String.raw`\[build\]\s+image = "${expectedImage.replaceAll(".", String.raw`\.`)}"`,
  ),
);
assert.equal(
  platformDigest,
  "sha256:4731fbc644c55088399f6a8c11105d9c3b300acb2b3beda71b581289327f2a4b",
);
assert.match(
  source,
  /\[deploy\][\s\S]*release_command = "node dist\/portable\/migrate\.js"[\s\S]*strategy = "rolling"/,
);
assert.match(
  source,
  /\[processes\][\s\S]*api = "node dist\/server\.js"[\s\S]*worker = "node dist\/portable\/worker\.js"/,
);
assert.match(
  source,
  /\[http_service\][\s\S]*processes = \["api"\][\s\S]*auto_stop_machines = "off"/,
);
assert.match(
  source,
  /\[\[http_service\.checks\]\][\s\S]*path = "\/readyz"/,
);
assert.match(
  source,
  /\[\[restart\]\][\s\S]*processes = \["worker"\][\s\S]*policy = "always"/,
);
assert.equal(
  [...source.matchAll(/^\[\[vm\]\]$/gm)].length,
  2,
);
assert.match(
  source,
  /HAYASEND_S3_ENDPOINT = "https:\/\/t3\.storage\.dev"/,
);
assert.match(source, /HAYASEND_TRANSPORT = "console"/);
assert.doesNotMatch(source, /HAYASEND_CONSOLE_PROOF_CONFIRM\s*=/);
assert.doesNotMatch(source, /HAYASEND_API_KEY\s*=/);
assert.doesNotMatch(source, /SENDGRID_API_KEY\s*=/);
assert.doesNotMatch(
  source,
  /SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY\s*=/,
);
assert.doesNotMatch(source, /HAYASEND_DATABASE_URL\s*=/);
assert.doesNotMatch(source, /AWS_ACCESS_KEY_ID\s*=/);
assert.doesNotMatch(source, /AWS_SECRET_ACCESS_KEY\s*=/);
assert.doesNotMatch(source, /\$\{/);

for (const scriptPath of ["deploy.sh", "rollback.sh"]) {
  const script = await readFile(
    new URL(`../deploy/flyio/${scriptPath}`, import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /HAYASEND_CONSOLE_PROOF_CONFIRM=\$HAYASEND_CONSOLE_PROOF_CONFIRM/,
  );
}
const library = await readFile(
  new URL("../deploy/flyio/lib.sh", import.meta.url),
  "utf8",
);
assert.match(
  library,
  /export HAYASEND_CONSOLE_PROOF_CONFIRM="isolated-non-sending"/,
);
assert.match(library, /unset HAYASEND_CONSOLE_PROOF_CONFIRM/);

console.log(
  "Fly.io config defines the expected immutable API, worker, migration, readiness, and secret boundaries.",
);
