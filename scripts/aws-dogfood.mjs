#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Resend } from "resend";
import { normalizeApiGatewayBaseUrl } from "./aws-integration-safety.mjs";
import {
  DOGFOOD_BATCH_SIZE,
  buildDogfoodMessage,
  planDogfoodRun,
  requireDogfoodRetryWindow,
} from "./aws-dogfood-plan.mjs";

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
const from = required("AWS_DOGFOOD_FROM");
const to = required("AWS_DOGFOOD_TO");
const startDate = required("AWS_DOGFOOD_START_DATE");
const runDate = required("AWS_DOGFOOD_RUN_DATE");
const slot = Number.parseInt(required("AWS_DOGFOOD_SLOT"), 10);
const requestedBatchSize = localProof
  ? Number.parseInt(process.env.HAYASEND_DOGFOOD_BATCH_SIZE ?? "4", 10)
  : DOGFOOD_BATCH_SIZE;
const plan = planDogfoodRun({
  startDate,
  runDate,
  slot,
  batchSize: requestedBatchSize,
});
if (!plan.active) {
  throw new Error("The requested dogfood slot is outside the active window.");
}
if (!localProof && plan.batch_size !== DOGFOOD_BATCH_SIZE) {
  throw new Error("The production dogfood batch size must remain 18.");
}
if (!localProof) {
  requireDogfoodRetryWindow(plan);
}

const sendTimeoutMs = localProof ? 30 : 15_000;
const sendRetryBaseMs = localProof ? 1 : 1_000;
const sendSpacingMs = localProof ? 1 : 300;
const pollTimeoutMs = localProof ? 100 : 8_000;
const pollIntervalMs = localProof ? 1 : 5_000;
const pollItemSpacingMs = localProof ? 1 : 300;
const deliveryTimeoutMs = localProof ? 2_000 : 20 * 60_000;
const transientStatusCodes = new Set([null, 408, 425, 429, 500, 502, 503, 504]);
const terminalFailures = new Set([
  "bounced",
  "complained",
  "failed",
  "rejected",
  "suppressed",
]);
const startedAt = Date.now();
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const progress = {
  object: "aws_dogfood_progress",
  run_date: plan.run_date,
  day_number: plan.day_number,
  slot: plan.slot,
  planned: plan.batch_size,
  submitted: 0,
  delivered: 0,
  send_attempts: 0,
  send_transient_failures: 0,
  poll_requests: 0,
  poll_transient_failures: 0,
  scoped_api_key_revoked: false,
};

const emitProgress = () => console.log(JSON.stringify(progress));

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

async function inspectEmail(token, id) {
  progress.poll_requests += 2;
  let emailResponse;
  let recipientResponse;
  try {
    [emailResponse, recipientResponse] = await Promise.all([
      fetch(new URL(`/emails/${encodeURIComponent(id)}`, baseUrl), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(pollTimeoutMs),
      }),
      fetch(
        new URL(
          `/emails/${encodeURIComponent(id)}/recipients?limit=1`,
          baseUrl,
        ),
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(pollTimeoutMs),
        },
      ),
    ]);
  } catch {
    progress.poll_transient_failures += 1;
    return undefined;
  }
  if (!emailResponse.ok || !recipientResponse.ok) {
    if (
      transientStatusCodes.has(emailResponse.status) ||
      transientStatusCodes.has(recipientResponse.status)
    ) {
      progress.poll_transient_failures += 1;
      return undefined;
    }
    throw new Error(
      `Delivery inspection failed with HTTP ${emailResponse.status}/${recipientResponse.status}.`,
    );
  }
  const email = await emailResponse.json();
  const recipients = await recipientResponse.json();
  return {
    email_status: email.status,
    aggregate_status: recipients.aggregate_status ?? "missing",
    recipient_status: recipients.data?.[0]?.status ?? "missing",
    attempt_summary: recipients.attempt_summary ?? {},
  };
}

let scopedApiKeyId;
let scopedApiKey;
let proof;
let failure;

try {
  const createdKey = await api("POST", "/api-keys", bootstrapKey, {
    name: `aws-dogfood-${plan.run_date}-s${plan.slot}`,
    scopes: ["emails:send", "emails:read"],
  });
  if (
    !createdKey?.id ||
    typeof createdKey.token !== "string" ||
    !createdKey.token.startsWith("re_hs_key_")
  ) {
    throw new Error("The scoped dogfood API key was not created.");
  }
  scopedApiKeyId = createdKey.id;
  scopedApiKey = createdKey.token;

  const resend = new Resend(scopedApiKey, { baseUrl });
  const messages = Array.from({ length: plan.batch_size }, (_, index) =>
    buildDogfoodMessage(plan, index, from, to),
  );
  const created = [];
  for (const [index, message] of messages.entries()) {
    let data;
    let sendError;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      progress.send_attempts += 1;
      const response = await resend.emails.send(message.payload, {
        idempotencyKey: message.idempotency_key,
        signal: AbortSignal.timeout(sendTimeoutMs),
      });
      data = response.data;
      sendError = response.error;
      if (data?.id) {
        break;
      }
      if (
        !sendError ||
        !transientStatusCodes.has(sendError.statusCode ?? null)
      ) {
        throw new Error(
          `Resend SDK send failed (${sendError?.name ?? "missing_id"}).`,
        );
      }
      progress.send_transient_failures += 1;
      await sleep(Math.min(2 ** attempt * sendRetryBaseMs, 10_000));
    }
    if (!data?.id || !/^email_[a-f0-9]{32}$/.test(data.id)) {
      throw new Error(
        `HayaSend did not return a valid identifier for item ${index + 1}.`,
      );
    }
    created.push({
      id: data.id,
      notification_type: message.notification_type,
      subject: message.payload.subject,
      status: undefined,
    });
    progress.submitted = created.length;
    emitProgress();
    await sleep(sendSpacingMs);
  }
  if (new Set(created.map((message) => message.id)).size !== created.length) {
    throw new Error(
      "Distinct dogfood idempotency keys returned duplicate IDs.",
    );
  }

  const pending = new Set(created.map((message) => message.id));
  const deliveryDeadline = Date.now() + deliveryTimeoutMs;
  while (pending.size > 0 && Date.now() < deliveryDeadline) {
    for (const message of created) {
      if (!pending.has(message.id)) {
        continue;
      }
      const status = await inspectEmail(scopedApiKey, message.id);
      if (!status) {
        await sleep(pollItemSpacingMs);
        continue;
      }
      message.status = status;
      if (
        status.email_status === "delivered" &&
        status.aggregate_status === "delivered" &&
        status.recipient_status === "delivered"
      ) {
        pending.delete(message.id);
        progress.delivered = created.length - pending.size;
      } else if (
        terminalFailures.has(status.email_status) ||
        terminalFailures.has(status.recipient_status)
      ) {
        throw new Error(
          `Amazon SES reported a terminal dogfood failure (${status.email_status}/${status.recipient_status}).`,
        );
      }
      await sleep(pollItemSpacingMs);
    }
    emitProgress();
    if (pending.size > 0) {
      await sleep(pollIntervalMs);
    }
  }
  if (pending.size > 0) {
    throw new Error(
      `${pending.size} dogfood messages did not reach terminal delivery before the deadline.`,
    );
  }

  const notificationCounts = Object.fromEntries(
    [...new Set(created.map((message) => message.notification_type))].map(
      (type) => [
        type,
        created.filter((message) => message.notification_type === type).length,
      ],
    ),
  );
  proof = {
    object: "aws_ses_dogfood_delivery_proof",
    campaign: plan,
    notification_counts: notificationCounts,
    submitted: created.length,
    delivered: created.length,
    unique_email_ids: new Set(created.map((message) => message.id)).size,
    email_ids: created.map((message) => message.id),
    email_id_sha256: created.map((message) => digest(message.id)),
    sample_subject: created[0]?.subject,
    send_attempts: progress.send_attempts,
    send_transient_failures: progress.send_transient_failures,
    poll_requests: progress.poll_requests,
    poll_transient_failures: progress.poll_transient_failures,
    scoped_api_key_revoked: false,
    operator_runtime_ms: Date.now() - startedAt,
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
        throw new Error("The scoped dogfood API key was not revoked.");
      }
      progress.scoped_api_key_revoked = true;
      if (proof) {
        proof.scoped_api_key_revoked = true;
      }
      emitProgress();
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            "Dogfood execution and scoped API key cleanup both failed.",
          )
        : cleanupError;
    }
  }
}

if (failure) {
  throw failure;
}
console.log(JSON.stringify(proof));
