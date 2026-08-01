#!/usr/bin/env node

import {
  DOGFOOD_EXPECTED_TOTAL,
  durationSummary,
} from "./aws-dogfood-plan.mjs";

let input;
try {
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  input = JSON.parse(raw);
} catch {
  throw new Error(
    "AWS dogfood evidence must be one JSON array provided on standard input.",
  );
}
const evidence = Array.isArray(input)
  ? input.filter((value) => value?.object === "aws_ses_dogfood_evidence")
  : [];
if (evidence.length === 0) {
  throw new Error("No AWS SES dogfood evidence objects were provided.");
}

const campaigns = new Set(
  evidence.map(
    (item) => `${item.campaign?.start_date}/${item.campaign?.end_date}`,
  ),
);
if (campaigns.size !== 1) {
  throw new Error("Evidence spans more than one campaign window.");
}
const [startDate, endDate] = [...campaigns][0].split("/");
const slots = new Map();
for (const item of evidence) {
  const campaign = item.campaign;
  const key = `${campaign?.run_date}/s${campaign?.slot}`;
  if (
    campaign?.active !== true ||
    campaign?.batch_size !== 18 ||
    campaign?.expected_total !== DOGFOOD_EXPECTED_TOTAL ||
    item.delivery?.submitted !== 18 ||
    item.delivery?.delivered !== 18 ||
    item.delivery?.unique_email_ids !== 18 ||
    item.delivery?.scoped_api_key_revoked !== true ||
    item.delivery?.terminal !== true ||
    item.ledger?.submitted !== 18 ||
    item.ledger?.delivered !== 18 ||
    item.ledger?.unexplained_loss !== 0 ||
    item.ledger?.duplicate_email_ids !== 0 ||
    item.ledger?.duplicate_terminal_events !== 0 ||
    item.ledger?.provider_id_correlated !== true ||
    item.ledger?.exact_recipient_correlated !== true ||
    item.ledger?.terminal !== true ||
    item.status_before?.operational !== true ||
    item.status_before?.send_ready !== true ||
    item.status_before?.alarms?.alarm !== 0 ||
    item.status_before?.alarms?.insufficient_data !== 0 ||
    item.status_after?.operational !== true ||
    item.status_after?.send_ready !== true ||
    item.status_after?.alarms?.alarm !== 0 ||
    item.status_after?.alarms?.insufficient_data !== 0 ||
    !/^[a-f0-9]{40}$/.test(item.source?.commit ?? "") ||
    !Array.isArray(item.delivery?.email_id_sha256) ||
    item.delivery.email_id_sha256.length !== 18 ||
    item.delivery.email_id_sha256.some(
      (digest) => !/^[a-f0-9]{64}$/.test(digest),
    )
  ) {
    throw new Error(`Dogfood slot ${key} is incomplete.`);
  }
  const existing = slots.get(key);
  if (existing) {
    const existingIds = [...existing.delivery.email_id_sha256].sort();
    const replayIds = [...item.delivery.email_id_sha256].sort();
    if (JSON.stringify(existingIds) !== JSON.stringify(replayIds)) {
      throw new Error(
        `Dogfood slot ${key} produced different IDs across re-runs.`,
      );
    }
    if (Date.parse(item.generated_at) > Date.parse(existing.generated_at)) {
      slots.set(key, item);
    }
  } else {
    slots.set(key, item);
  }
}

const start = new Date(`${startDate}T00:00:00.000Z`);
const expectedKeys = [];
for (let day = 0; day < 14; day += 1) {
  const date = new Date(start.getTime() + day * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (let slot = 0; slot < 4; slot += 1) {
    expectedKeys.push(`${date}/s${slot}`);
  }
}
if (expectedKeys.some((key) => !slots.has(key))) {
  const missing = expectedKeys.filter((key) => !slots.has(key));
  throw new Error(`The campaign is missing slots: ${missing.join(", ")}.`);
}
if (slots.size !== expectedKeys.length) {
  throw new Error("The campaign contains an unexpected date or slot.");
}

const selected = expectedKeys.map((key) => slots.get(key));
const emailDigests = selected.flatMap((item) => item.delivery.email_id_sha256);
if (
  emailDigests.length !== DOGFOOD_EXPECTED_TOTAL ||
  new Set(emailDigests).size !== DOGFOOD_EXPECTED_TOTAL
) {
  throw new Error("The campaign does not contain 1,008 unique email IDs.");
}
const sum = (selector) =>
  selected.reduce((total, item) => total + selector(item), 0);
const latency = Object.fromEntries(
  [
    "queue_to_provider",
    "provider_terminal",
    "provider_event_ingest",
    "end_to_end",
  ].map((name) => [
    name,
    {
      slot_p95: durationSummary(
        selected.map((item) => item.ledger.latency[name].p95_ms),
      ),
      maximum_ms: Math.max(
        ...selected.map((item) => item.ledger.latency[name].max_ms),
      ),
    },
  ]),
);

console.log(
  JSON.stringify({
    object: "aws_ses_dogfood_campaign_report",
    campaign: {
      start_date: startDate,
      end_date: endDate,
      consecutive_days: 14,
      slots: selected.length,
      submitted: DOGFOOD_EXPECTED_TOTAL,
      delivered: DOGFOOD_EXPECTED_TOTAL,
    },
    commits: [...new Set(selected.map((item) => item.source.commit))],
    workflow_run_ids: selected.map((item) => item.source.workflow_run_id),
    unique_email_ids: new Set(emailDigests).size,
    unexplained_loss: 0,
    duplicate_email_ids: 0,
    duplicate_terminal_events: 0,
    total_attempts: sum((item) => item.ledger.total_attempts),
    retryable_failures: sum((item) => item.ledger.retryable_failures),
    operator_runtime_ms: sum((item) => item.delivery.operator_runtime_ms),
    latency,
    alarmed_slots: 0,
    credential_cleanup_verified: true,
    terminal: true,
  }),
);
