#!/usr/bin/env node

import { Resend } from "resend";
import { normalizeApiGatewayBaseUrl } from "./aws-integration-safety.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const suppliedBaseUrl = required("HAYASEND_BASE_URL");
const suppliedEndpoint = new URL(suppliedBaseUrl);
const localProof =
  suppliedEndpoint.protocol === "http:" &&
  suppliedEndpoint.hostname === "127.0.0.1";
const baseUrl = localProof
  ? suppliedEndpoint.origin
  : normalizeApiGatewayBaseUrl(
      suppliedBaseUrl,
      required("HAYASEND_EXPECTED_API_ID"),
      required("AWS_REGION"),
    );
const bootstrapKey = required("HAYASEND_BOOTSTRAP_KEY");
const from = required("AWS_TERMINAL_FROM");
const to = required("AWS_TERMINAL_TO");
const runId = required("GITHUB_RUN_ID");
const runAttempt = required("GITHUB_RUN_ATTEMPT");
const sendTimeoutMs = localProof ? 30 : 15_000;
const sendRetryBaseMs = localProof ? 1 : 1_000;
const pollTimeoutMs = localProof ? 100 : 8_000;
const pollIntervalMs = localProof ? 1 : 5_000;
const deliveryTimeoutMs = localProof ? 2_000 : 15 * 60_000;
const subject = `HayaSend AWS SES terminal delivery ${runId}-${runAttempt}`;
const transientStatusCodes = new Set([
  null,
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);
const terminalFailures = new Set([
  "bounced",
  "complained",
  "failed",
  "rejected",
  "suppressed",
]);
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const observation = {
  object: "aws_ses_terminal_delivery_observation",
  subject,
  sdk: "resend",
  send_attempts: 0,
  send_transient_failures: 0,
  poll_attempts: 0,
  poll_transient_failures: 0,
  email_id: undefined,
  email_status: "not_created",
  aggregate_status: "not_created",
  recipient_status: "not_created",
  scoped_api_key_revoked: false,
  terminal: false,
};

const persistObservation = () => {
  console.log(JSON.stringify(observation));
};

async function api(method, path, token, body, expectedStatus = 200) {
  const response = await fetch(new URL(path, `${baseUrl}/`), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(pollTimeoutMs),
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} returned HTTP ${response.status}, expected ${expectedStatus}.`,
    );
  }
  const raw = await response.text();
  return raw ? JSON.parse(raw) : undefined;
}

let scopedApiKeyId;
let scopedApiKey;
let proof;
let failure;

try {
  const createdKey = await api("POST", "/api-keys", bootstrapKey, {
    name: `aws-terminal-${runId}-${runAttempt}`,
    scopes: ["emails:send", "emails:read"],
  });
  if (
    !createdKey?.id ||
    typeof createdKey.token !== "string" ||
    !createdKey.token.startsWith("re_hs_key_")
  ) {
    throw new Error("The scoped terminal-proof API key was not created.");
  }
  scopedApiKeyId = createdKey.id;
  scopedApiKey = createdKey.token;

  const resend = new Resend(scopedApiKey, { baseUrl });
  const payload = {
    from,
    to,
    subject,
    text: "Controlled SES terminal-delivery proof. No customer or private content.",
  };
  const idempotencyKey = `hayasend-aws-terminal-${runId}-${runAttempt}`;
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
  if (!/^email_[a-f0-9]{32}$/.test(data.id)) {
    throw new Error("HayaSend returned an invalid email identifier.");
  }

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
        fetch(new URL(`/emails/${encodeURIComponent(data.id)}`, baseUrl), {
          headers: { authorization: `Bearer ${scopedApiKey}` },
          signal: AbortSignal.timeout(pollTimeoutMs),
        }),
        fetch(
          new URL(
            `/emails/${encodeURIComponent(data.id)}/recipients?limit=1`,
            baseUrl,
          ),
          {
            headers: { authorization: `Bearer ${scopedApiKey}` },
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
    observation.email_status = emailStatus;
    observation.aggregate_status =
      recipientSummary.aggregate_status ?? "missing";
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
        `Amazon SES reported a terminal delivery failure (${emailStatus}/${recipientStatus}).`,
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
      `Amazon SES remained provider-accepted without a delivered event (${emailStatus}/${recipientStatus}).`,
    );
  }

  proof = {
    object: "aws_ses_terminal_delivery_proof",
    email_id: data.id,
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
    scoped_api_key_revoked: false,
    terminal: true,
  };
} catch (error) {
  failure = error;
} finally {
  if (scopedApiKeyId) {
    try {
      const revoked = await api(
        "DELETE",
        `/api-keys/${encodeURIComponent(scopedApiKeyId)}`,
        bootstrapKey,
      );
      if (revoked?.id !== scopedApiKeyId || revoked.revoked !== true) {
        throw new Error("The scoped terminal-proof API key was not revoked.");
      }
      observation.scoped_api_key_revoked = true;
      if (proof) {
        proof.scoped_api_key_revoked = true;
      }
      persistObservation();
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            "Terminal proof and scoped API key cleanup both failed.",
          )
        : cleanupError;
    }
  }
}

if (failure) {
  throw failure;
}
console.log(JSON.stringify(proof));
