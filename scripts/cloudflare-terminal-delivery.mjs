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
const subject = `HayaSend Cloudflare terminal delivery ${runId}-${runAttempt}`;
const resend = new Resend(apiKey, { baseUrl: endpoint.origin });
const { data, error } = await resend.emails.send(
  {
    from,
    to,
    subject,
    text: "Controlled terminal-delivery proof. No customer or private content.",
  },
  {
    idempotencyKey: `hayasend-cloudflare-terminal-${runId}-${runAttempt}`,
  },
);
if (error || !data?.id) {
  throw new Error(`Resend SDK send failed (${error?.name ?? "missing_id"}).`);
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
for (let attempt = 0; attempt < 120; attempt += 1) {
  const emailResponse = await fetch(
    new URL(`/emails/${encodeURIComponent(data.id)}`, endpoint),
    {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  const recipientResponse = await fetch(
    new URL(
      `/emails/${encodeURIComponent(data.id)}/recipients?limit=1`,
      endpoint,
    ),
    {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!emailResponse.ok || !recipientResponse.ok) {
    throw new Error(
      `Delivery inspection failed with HTTP ${emailResponse.status}/${recipientResponse.status}.`,
    );
  }
  const email = await emailResponse.json();
  recipientSummary = await recipientResponse.json();
  emailStatus = email.status;
  recipientStatus = recipientSummary.data?.[0]?.status ?? "missing";
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
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

if (
  emailStatus !== "delivered" ||
  recipientSummary?.aggregate_status !== "delivered" ||
  recipientStatus !== "delivered"
) {
  throw new Error(
    `Cloudflare remained provider-accepted without a delivered event (${emailStatus}/${recipientStatus}).`,
  );
}

console.log(
  JSON.stringify({
    object: "cloudflare_terminal_delivery_proof",
    email_id: data.id,
    subject,
    email_status: emailStatus,
    aggregate_status: recipientSummary.aggregate_status,
    recipient_status: recipientStatus,
    attempt_summary: recipientSummary.attempt_summary,
    sdk: "resend",
  }),
);
