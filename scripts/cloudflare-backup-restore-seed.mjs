#!/usr/bin/env node

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const endpoint = new URL(required("CF_ENDPOINT"));
if (
  endpoint.protocol !== "https:" ||
  !endpoint.hostname.endsWith(".workers.dev") ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
) {
  throw new Error("CF_ENDPOINT must be a controlled HTTPS workers.dev URL.");
}

const apiKey = required("HAYASEND_CLOUDFLARE_API_KEY");
const from = required("CLOUDFLARE_TEST_FROM");
const to = required("CLOUDFLARE_TEST_TO");
const runId = required("GITHUB_RUN_ID");
const runAttempt = required("GITHUB_RUN_ATTEMPT");
const scheduledAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

const response = await fetch(new URL("/emails", endpoint), {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "idempotency-key":
      `hayasend-cloudflare-backup-restore-${runId}-${runAttempt}`,
  },
  body: JSON.stringify({
    from,
    to: [to],
    subject: `HayaSend Cloudflare restore drill ${runId}-${runAttempt}`,
    text: "Controlled future-due backup and restore fixture.",
    scheduled_at: scheduledAt,
  }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) {
  throw new Error(
    `Scheduled restore fixture failed with HTTP ${response.status}.`,
  );
}
const created = await response.json();
if (
  !created ||
  typeof created !== "object" ||
  typeof created.id !== "string" ||
  !/^email_[a-f0-9]{32}$/u.test(created.id)
) {
  throw new Error("Scheduled restore fixture returned an invalid ID.");
}

const retrieved = await fetch(
  new URL(`/emails/${encodeURIComponent(created.id)}`, endpoint),
  {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  },
);
if (!retrieved.ok) {
  throw new Error(
    `Scheduled restore fixture lookup failed with HTTP ${retrieved.status}.`,
  );
}
const record = await retrieved.json();
if (
  !record ||
  typeof record !== "object" ||
  record.id !== created.id ||
  record.status !== "scheduled" ||
  record.scheduled_at !== scheduledAt
) {
  throw new Error("Scheduled restore fixture did not persist durably.");
}

console.log(
  JSON.stringify({
    object: "cloudflare_backup_restore_seed",
    scheduled_email_id: created.id,
    status: record.status,
    scheduled_at: scheduledAt,
  }),
);
