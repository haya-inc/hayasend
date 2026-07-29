#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Resend } from "resend";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const suppliedEndpoint = new URL(required("HAYASEND_BASE_URL"));
const localProof =
  suppliedEndpoint.protocol === "http:" &&
  suppliedEndpoint.hostname === "127.0.0.1";
if (
  suppliedEndpoint.username ||
  suppliedEndpoint.password ||
  suppliedEndpoint.pathname !== "/" ||
  suppliedEndpoint.search ||
  suppliedEndpoint.hash ||
  (!localProof &&
    (suppliedEndpoint.protocol !== "https:" ||
      !suppliedEndpoint.hostname.endsWith(
        ".azurecontainerapps.io",
      )))
) {
  throw new Error(
    "HAYASEND_BASE_URL must be the credential-free Azure Container Apps HTTPS origin.",
  );
}

const baseUrl = suppliedEndpoint.origin;
const bootstrapKey = required("HAYASEND_BOOTSTRAP_KEY");
const eventGridSecret = required(
  "HAYASEND_AZURE_EVENT_GRID_SECRET",
);
const eventTopic = required("HAYASEND_AZURE_EVENT_TOPIC");
const normalizedEventTopic = eventTopic.toLowerCase();
const from = required("AZURE_TERMINAL_FROM");
const recipients = JSON.parse(required("AZURE_TERMINAL_TO_JSON"));
const runId = required("GITHUB_RUN_ID");
const runAttempt = required("GITHUB_RUN_ATTEMPT");
if (
  !Array.isArray(recipients) ||
  recipients.length !== 2 ||
  !recipients.every(
    (value) =>
      typeof value === "string" &&
      value.length >= 3 &&
      value.length <= 320 &&
      !/[\r\n\u0000]/.test(value),
  ) ||
  new Set(recipients).size !== 2
) {
  throw new Error(
    "AZURE_TERMINAL_TO_JSON must contain exactly two distinct controlled recipient addresses.",
  );
}
if (
  !normalizedEventTopic.startsWith("/subscriptions/") ||
  !normalizedEventTopic.includes(
    "/providers/microsoft.communication/communicationservices/",
  )
) {
  throw new Error(
    "HAYASEND_AZURE_EVENT_TOPIC must be an exact ACS resource ID.",
  );
}

const sendTimeoutMs = localProof ? 30 : 15_000;
const sendRetryBaseMs = localProof ? 1 : 1_000;
const pollTimeoutMs = localProof ? 100 : 8_000;
const pollIntervalMs = localProof ? 1 : 5_000;
const deliveryTimeoutMs = localProof ? 2_000 : 15 * 60_000;
const subject = `HayaSend Azure ACS terminal delivery ${runId}-${runAttempt}`;
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
const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const observation = {
  object: "azure_acs_terminal_delivery_observation",
  sdk: "resend",
  send_attempts: 0,
  send_transient_failures: 0,
  poll_attempts: 0,
  poll_transient_failures: 0,
  email_reference_sha256: undefined,
  email_status: "not_created",
  aggregate_status: "not_created",
  recipient_statuses: [],
  scoped_api_key_revoked: false,
  real_terminal_delivery_observed: false,
  synthetic_convergence_verified: false,
  terminal: false,
};

const persistObservation = () => {
  console.log(JSON.stringify(observation));
};

async function api(
  method,
  path,
  token,
  body,
  expectedStatus = 200,
) {
  const response = await fetch(new URL(path, `${baseUrl}/`), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined
        ? {}
        : { "content-type": "application/json" }),
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

async function inspectDelivery(emailId, token) {
  const [emailResponse, recipientResponse] = await Promise.all([
    fetch(new URL(`/emails/${encodeURIComponent(emailId)}`, baseUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(pollTimeoutMs),
    }),
    fetch(
      new URL(
        `/emails/${encodeURIComponent(emailId)}/recipients?limit=2`,
        baseUrl,
      ),
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(pollTimeoutMs),
      },
    ),
  ]);
  if (!emailResponse.ok || !recipientResponse.ok) {
    const error = new Error(
      `Delivery inspection failed with HTTP ${emailResponse.status}/${recipientResponse.status}.`,
    );
    error.statuses = [emailResponse.status, recipientResponse.status];
    throw error;
  }
  return {
    email: await emailResponse.json(),
    recipients: await recipientResponse.json(),
  };
}

async function postEventGrid(events) {
  const response = await fetch(
    new URL("/events/azure-email", baseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hayasend-event-grid-secret": eventGridSecret,
      },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(pollTimeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Synthetic Event Grid convergence request returned HTTP ${response.status}.`,
    );
  }
  const result = await response.json();
  if (result.accepted !== true) {
    throw new Error(
      "Synthetic Event Grid convergence request was not accepted.",
    );
  }
}

function deliveryEvent(
  recipient,
  ordinal,
  status,
  suffix,
  timestamp,
  providerMessageId,
) {
  return {
    id: `hayasend-azure-${runId}-${runAttempt}-${ordinal}-${suffix}`,
    topic: eventTopic,
    subject: `sender/hayasend/message/${providerMessageId}`,
    data: {
      sender: from,
      recipient,
      messageId: providerMessageId,
      status,
      deliveryAttemptTimeStamp: timestamp,
    },
    eventType:
      "Microsoft.Communication.EmailDeliveryReportReceived",
    dataVersion: "1.0",
    metadataVersion: "1",
    eventTime: timestamp,
  };
}

let scopedApiKeyId;
let scopedApiKey;
let proof;
let failure;

try {
  const createdKey = await api("POST", "/api-keys", bootstrapKey, {
    name: `azure-terminal-${runId}-${runAttempt}`,
    scopes: ["emails:send", "emails:read"],
  });
  if (
    !createdKey?.id ||
    typeof createdKey.token !== "string" ||
    !createdKey.token.startsWith("re_hs_key_")
  ) {
    throw new Error("The scoped Azure terminal-proof API key was not created.");
  }
  scopedApiKeyId = createdKey.id;
  scopedApiKey = createdKey.token;

  const resend = new Resend(scopedApiKey, { baseUrl });
  const payload = {
    from,
    to: recipients,
    subject,
    text: "Controlled Azure ACS terminal-delivery proof. No customer or private content.",
  };
  const idempotencyKey = `hayasend-azure-terminal-${runId}-${runAttempt}`;
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
      observation.email_reference_sha256 = digest(data.id);
      observation.email_status = "created";
      observation.aggregate_status = "created";
      observation.recipient_statuses = ["created", "created"];
      persistObservation();
      break;
    }
    if (
      !sendError ||
      !transientStatusCodes.has(sendError.statusCode ?? null)
    ) {
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

  let inspection;
  const deliveryDeadline = Date.now() + deliveryTimeoutMs;
  while (Date.now() < deliveryDeadline) {
    observation.poll_attempts += 1;
    try {
      inspection = await inspectDelivery(data.id, scopedApiKey);
    } catch (error) {
      if (
        error.statuses?.every((status) =>
          transientStatusCodes.has(status),
        )
      ) {
        observation.poll_transient_failures += 1;
        persistObservation();
        await sleep(pollIntervalMs);
        continue;
      }
      throw error;
    }
    const statuses =
      inspection.recipients.data?.map((entry) => entry.status) ?? [];
    observation.email_status = inspection.email.status;
    observation.aggregate_status =
      inspection.recipients.aggregate_status ?? "missing";
    observation.recipient_statuses = statuses;
    persistObservation();
    if (
      inspection.email.status === "delivered" &&
      inspection.recipients.aggregate_status === "delivered" &&
      statuses.length === 2 &&
      statuses.every((status) => status === "delivered")
    ) {
      break;
    }
    if (
      terminalFailures.has(inspection.email.status) ||
      statuses.some((status) => terminalFailures.has(status))
    ) {
      throw new Error(
        "Azure ACS reported a terminal delivery failure.",
      );
    }
    await sleep(pollIntervalMs);
  }

  const deliveredStatuses =
    inspection?.recipients.data?.map((entry) => entry.status) ?? [];
  if (
    inspection?.email.status !== "delivered" ||
    inspection.recipients.aggregate_status !== "delivered" ||
    deliveredStatuses.length !== 2 ||
    !deliveredStatuses.every((status) => status === "delivered")
  ) {
    throw new Error(
      "Azure ACS remained provider-accepted without two recipient-level delivered events.",
    );
  }
  const providerMessageId = inspection.email.message_id;
  if (
    typeof providerMessageId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,512}$/.test(providerMessageId)
  ) {
    throw new Error(
      "Azure ACS terminal proof is missing the correlated provider message ID.",
    );
  }
  observation.real_terminal_delivery_observed = true;
  persistObservation();

  const deliveredAt = new Date().toISOString();
  const olderAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const syntheticDelivered = recipients.map((recipient, ordinal) =>
    deliveryEvent(
      recipient,
      ordinal,
      "Delivered",
      "replay",
      deliveredAt,
      providerMessageId,
    ),
  );
  const syntheticOlder = recipients.map((recipient, ordinal) =>
    deliveryEvent(
      recipient,
      ordinal,
      "Expanded",
      "older",
      olderAt,
      providerMessageId,
    ),
  );
  await postEventGrid(syntheticDelivered);
  await postEventGrid(syntheticDelivered);
  await postEventGrid(syntheticOlder);

  const unattributedBefore =
    inspection.recipients.unattributed_event_count ?? 0;
  const engagement = {
    id: `hayasend-azure-${runId}-${runAttempt}-engagement`,
    topic: eventTopic,
    subject: `sender/hayasend/message/${providerMessageId}`,
    data: {
      sender: from,
      messageId: providerMessageId,
      userActionTimeStamp: deliveredAt,
      engagementType: "view",
    },
    eventType:
      "Microsoft.Communication.EmailEngagementTrackingReportReceived",
    dataVersion: "1.0",
    metadataVersion: "1",
    eventTime: deliveredAt,
  };
  await postEventGrid([engagement]);
  await postEventGrid([engagement]);

  const converged = await inspectDelivery(data.id, scopedApiKey);
  const convergedStatuses =
    converged.recipients.data?.map((entry) => entry.status) ?? [];
  if (
    converged.email.status !== "delivered" ||
    converged.recipients.aggregate_status !== "delivered" ||
    convergedStatuses.length !== 2 ||
    !convergedStatuses.every((status) => status === "delivered") ||
    converged.recipients.unattributed_event_count !==
      unattributedBefore + 1
  ) {
    throw new Error(
      "Duplicate, out-of-order, or unattributed Azure events did not converge safely.",
    );
  }
  observation.synthetic_convergence_verified = true;
  persistObservation();

  proof = {
    object: "azure_acs_terminal_delivery_proof",
    email_reference_sha256: digest(data.id),
    email_status: converged.email.status,
    aggregate_status: converged.recipients.aggregate_status,
    recipient_statuses: convergedStatuses,
    recipient_count: 2,
    provider_message_id_sha256: digest(providerMessageId),
    attempt_summary: converged.recipients.attempt_summary,
    duplicate_delivery_replay_converged: true,
    older_expanded_event_did_not_regress: true,
    unattributed_engagement_deduplicated: true,
    real_terminal_delivery_observed: true,
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
        throw new Error(
          "The scoped Azure terminal-proof API key was not revoked.",
        );
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
            "Azure terminal proof and scoped API key cleanup both failed.",
          )
        : cleanupError;
    }
  }
}

if (failure) {
  throw failure;
}
console.log(JSON.stringify(proof));
