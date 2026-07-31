#!/usr/bin/env node

import { Resend } from "resend";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const endpoint = new URL(required("CF_ENDPOINT"));
const apiKey = required("HAYASEND_CLOUDFLARE_API_KEY");
const from = required("CLOUDFLARE_TEST_FROM");
const to = required("CLOUDFLARE_TEST_TO");
const runId = required("GITHUB_RUN_ID");
const runAttempt = required("GITHUB_RUN_ATTEMPT");
const localProof = endpoint.hostname === "127.0.0.1";
const sendTimeoutMs = localProof ? 30 : 15_000;
const sendRetryBaseMs = localProof ? 1 : 1_000;
const pollTimeoutMs = localProof ? 100 : 8_000;
const pollIntervalMs = localProof ? 1 : 5_000;
const deliveryTimeoutMs = localProof ? 2_000 : 15 * 60_000;
const subject = `HayaSend Cloudflare terminal delivery ${runId}-${runAttempt}`;
const resend = new Resend(apiKey, { baseUrl: endpoint.origin });

const observation = {
  object: "cloudflare_terminal_delivery_observation",
  subject,
  sdk: "resend",
  send_attempts: 0,
  send_transient_failures: 0,
  poll_attempts: 0,
  poll_transient_failures: 0,
  email_id: undefined,
  provider_message_id: undefined,
  email_status: "not_created",
  aggregate_status: "not_created",
  recipient_status: "not_created",
  terminal: false,
};

const persistObservation = () => {
  console.log(JSON.stringify(observation));
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const transientStatusCodes = new Set([null, 408, 425, 429, 500, 502, 503, 504]);
const idempotencyKey = `hayasend-cloudflare-terminal-${runId}-${runAttempt}`;
const payload = {
  from,
  to,
  subject,
  text: "Controlled terminal-delivery proof. No customer or private content.",
};
let data;
let sendError;
for (let attempt = 1; attempt <= 6; attempt += 1) {
  observation.send_attempts = attempt;
  const response = await resend.emails.send(payload, {
    idempotencyKey,
    signal: AbortSignal.timeout(sendTimeoutMs),
  });
  data = response.data;
  sendError = response.error;
  if (data?.id) {
    observation.email_id = data.id;
    observation.email_status = "created";
    observation.aggregate_status = "created";
    observation.recipient_status = "created";
    persistObservation();
    break;
  }
  if (!sendError || !transientStatusCodes.has(sendError.statusCode ?? null)) {
    persistObservation();
    throw new Error(
      `Resend SDK send failed (${sendError?.name ?? "missing_id"}).`,
    );
  }
  observation.send_transient_failures += 1;
  persistObservation();
  await sleep(Math.min(2 ** attempt * sendRetryBaseMs, 10_000));
}
if (!data?.id) {
  throw new Error(
    `Resend SDK send remained unavailable after ${observation.send_attempts} idempotent attempts (${sendError?.name ?? "missing_id"}).`,
  );
}

const terminalFailures = new Set([
  "bounced",
  "complained",
  "failed",
  "rejected",
]);
let emailStatus = "queued";
let recipientStatus = "queued";
let recipientSummary;
const deliveryDeadline = Date.now() + deliveryTimeoutMs;
while (Date.now() < deliveryDeadline) {
  observation.poll_attempts += 1;
  let emailResponse;
  let recipientResponse;
  try {
    [emailResponse, recipientResponse] = await Promise.all([
      fetch(new URL(`/emails/${encodeURIComponent(data.id)}`, endpoint), {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(pollTimeoutMs),
      }),
      fetch(
        new URL(
          `/emails/${encodeURIComponent(data.id)}/recipients?limit=1`,
          endpoint,
        ),
        {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(pollTimeoutMs),
        },
      ),
    ]);
  } catch {
    observation.poll_transient_failures += 1;
    persistObservation();
    await sleep(pollIntervalMs);
    continue;
  }
  if (!emailResponse.ok || !recipientResponse.ok) {
    if (
      transientStatusCodes.has(emailResponse.status) ||
      transientStatusCodes.has(recipientResponse.status)
    ) {
      observation.poll_transient_failures += 1;
      persistObservation();
      await sleep(pollIntervalMs);
      continue;
    }
    persistObservation();
    throw new Error(
      `Delivery inspection failed with HTTP ${emailResponse.status}/${recipientResponse.status}.`,
    );
  }
  const email = await emailResponse.json();
  recipientSummary = await recipientResponse.json();
  emailStatus = email.status;
  recipientStatus = recipientSummary.data?.[0]?.status ?? "missing";
  observation.provider_message_id =
    email.message_id ?? observation.provider_message_id;
  observation.email_status = emailStatus;
  observation.aggregate_status = recipientSummary.aggregate_status ?? "missing";
  observation.recipient_status = recipientStatus;
  persistObservation();
  if (
    emailStatus === "delivered" &&
    recipientSummary.aggregate_status === "delivered" &&
    recipientStatus === "delivered"
  ) {
    break;
  }
  if (
    terminalFailures.has(emailStatus) ||
    terminalFailures.has(recipientStatus)
  ) {
    throw new Error(
      `Cloudflare reported a terminal delivery failure (${emailStatus}/${recipientStatus}).`,
    );
  }
  await sleep(pollIntervalMs);
}

if (
  emailStatus !== "delivered" ||
  recipientSummary?.aggregate_status !== "delivered" ||
  recipientStatus !== "delivered"
) {
  persistObservation();
  throw new Error(
    `Cloudflare accepted the message but published no terminal event within the deadline (${emailStatus}/${recipientStatus}). ` +
      "This is an observability failure and is NOT evidence of non-delivery: correlate provider message ID " +
      `${observation.provider_message_id ?? "unknown"} against the recipient mailbox ` +
      "(rfc822msgid lookup) before making any delivery claim.",
  );
}

const proof = {
  object: "cloudflare_terminal_delivery_proof",
  email_id: data.id,
  provider_message_id: observation.provider_message_id,
  subject,
  email_status: emailStatus,
  aggregate_status: recipientSummary.aggregate_status,
  recipient_status: recipientStatus,
  attempt_summary: recipientSummary.attempt_summary,
  sdk: "resend",
  send_attempts: observation.send_attempts,
  send_transient_failures: observation.send_transient_failures,
  poll_attempts: observation.poll_attempts,
  poll_transient_failures: observation.poll_transient_failures,
  terminal: true,
};
console.log(JSON.stringify(proof));
