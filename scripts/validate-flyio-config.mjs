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
  "ghcr.io/haya-inc/hayasend@sha256:8358bf6463372e95bf7e5fdbae493634d3a200621efddf2fb722c8b64514fc96";

assert.match(
  source,
  new RegExp(
    String.raw`\[build\]\s+image = "${expectedImage.replaceAll(".", String.raw`\.`)}"`,
  ),
);
assert.equal(
  platformDigest,
  "sha256:59de1435b05e09bbcf96cec805af8bdb4fb9919807f0f7a8dc3f1d965860c0cd",
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
assert.match(source, /HAYASEND_TRANSPORT = "sendgrid"/);
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

console.log(
  "Fly.io config defines the expected immutable API, worker, migration, readiness, and secret boundaries.",
);
