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
const resend = new Resend(apiKey, { baseUrl: endpoint.origin });
const { data, error } = await resend.emails.send({
  from,
  to,
  subject: `HayaSend Cloudflare integration ${runId}`,
  text: "Controlled disposable-account integration message.",
});
if (error || !data?.id) {
  throw new Error(
    `Resend SDK send failed (${error?.name ?? "missing_id"}).`,
  );
}

let status = "queued";
for (let attempt = 0; attempt < 30; attempt += 1) {
  const response = await fetch(
    new URL(`/emails/${encodeURIComponent(data.id)}`, endpoint),
    {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Email retrieval failed with HTTP ${response.status}.`);
  }
  const record = await response.json();
  status = record.status;
  if (
    [
      "sent",
      "delivered",
      "delivery_delayed",
      "bounced",
      "complained",
      "failed",
    ].includes(status)
  ) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!["sent", "delivered", "delivery_delayed"].includes(status)) {
  throw new Error(`Email did not reach an accepted provider state (${status}).`);
}
console.log(
  JSON.stringify({
    object: "cloudflare_api_proof",
    email_id: data.id,
    status,
    sdk: "resend",
  }),
);
