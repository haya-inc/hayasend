import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeApiGatewayBaseUrl } from "./aws-integration-safety.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const baseUrl = normalizeApiGatewayBaseUrl(
  requiredEnvironment("HAYASEND_BASE_URL"),
  requiredEnvironment("HAYASEND_EXPECTED_API_ID"),
  requiredEnvironment("AWS_REGION"),
);
const bootstrapKey = requiredEnvironment("HAYASEND_BOOTSTRAP_KEY");
const runId = (process.env.GITHUB_RUN_ID ?? String(Date.now())).replace(
  /[^a-zA-Z0-9-]/g,
  "",
);

async function api(
  method,
  path,
  token,
  body,
  expectedStatus = 200,
  extraHeaders = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${expectedStatus}.`,
    );
  }
  return raw ? JSON.parse(raw) : undefined;
}

async function bestEffort(label, operation) {
  try {
    await operation();
  } catch {
    console.warn(`Cleanup warning: ${label} could not be removed.`);
  }
}

function assertQueueDepth(value) {
  assert.ok(value && typeof value === "object");
  for (const name of ["visible", "in_flight", "delayed", "total"]) {
    assert.ok(
      Number.isSafeInteger(value[name]) && value[name] >= 0,
      `${name} must be a non-negative safe integer.`,
    );
  }
  assert.equal(value.total, value.visible + value.in_flight + value.delayed);
}

function assertPrivateValuesAbsent(value, privateValues) {
  const serialized = JSON.stringify(value);
  for (const privateValue of privateValues) {
    assert.equal(serialized.includes(privateValue), false);
  }
  return serialized;
}

function assertForbiddenFieldsAbsent(value, forbiddenFields) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertForbiddenFieldsAbsent(entry, forbiddenFields);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    assert.equal(
      forbiddenFields.has(name),
      false,
      `${name} must not be exported by this endpoint.`,
    );
    assertForbiddenFieldsAbsent(entry, forbiddenFields);
  }
}

const PRIVATE_DIAGNOSTIC_FIELDS = new Set([
  "address",
  "bcc",
  "cc",
  "error",
  "from",
  "html",
  "object_key",
  "provider_id",
  "provider_message_id",
  "raw_error",
  "signing_secret",
  "subject",
  "text",
  "to",
  "upload_url",
]);

const created = {
  apiKeyIds: [],
  domainId: undefined,
  emailId: undefined,
  suppressionEmail: undefined,
  webhookId: undefined,
};
let applicationKey;
let recoveryEmailId;

try {
  const health = await api("GET", "/healthz", undefined);
  assert.equal(health.ok, true);
  assert.equal(health.service, "hayasend");

  const fullKey = await api("POST", "/api-keys", bootstrapKey, {
    name: `aws-integration-${runId}`,
    scopes: [
      "emails:send",
      "emails:read",
      "diagnostics:read",
      "domains:read",
      "domains:write",
      "webhooks:read",
      "webhooks:write",
      "suppressions:read",
      "suppressions:write",
    ],
  });
  created.apiKeyIds.push(fullKey.id);
  applicationKey = fullKey.token;
  assert.match(applicationKey, /^re_hs_key_/);

  const sendOnlyKey = await api("POST", "/api-keys", bootstrapKey, {
    name: `aws-integration-send-only-${runId}`,
    scopes: ["emails:send"],
  });
  created.apiKeyIds.push(sendOnlyKey.id);
  await api("GET", "/emails", sendOnlyKey.token, undefined, 403);
  await api("GET", "/diagnostics/recovery", sendOnlyKey.token, undefined, 403);

  const attachmentContent = Buffer.from(
    `HayaSend AWS integration attachment ${runId}`,
  );
  const checksum = createHash("sha256").update(attachmentContent).digest("hex");
  const upload = await api("POST", "/attachments", applicationKey, {
    filename: "integration.txt",
    content_type: "text/plain",
    size_bytes: attachmentContent.byteLength,
    checksum_sha256: checksum,
  });
  assert.match(upload.id, /^att_[a-f0-9]{32}$/);
  assert.equal(upload.upload_method, "PUT");
  assert.equal(upload.checksum_sha256, checksum);

  const uploadResponse = await fetch(upload.upload_url, {
    method: upload.upload_method,
    headers: upload.upload_headers,
    body: attachmentContent,
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(
    [200, 204].includes(uploadResponse.status),
    `Attachment PUT returned ${uploadResponse.status}.`,
  );

  const privateRecipients = [
    `recipient-${runId}-a@example.net`,
    `recipient-${runId}-b@example.net`,
  ];
  const privateSubject = `AWS integration ${runId}`;
  const privateBody =
    "This private integration message is canceled before delivery.";
  const scheduledInput = {
    from: "HayaSend Integration <sender@example.com>",
    to: privateRecipients,
    subject: privateSubject,
    html: `<p>${privateBody}</p>`,
    scheduled_at: "in 20 minutes",
    attachments: [{ attachment_id: upload.id }],
  };
  const idempotencyKey = `hayasend-aws-restore-${runId}`;
  const scheduled = await api(
    "POST",
    "/emails",
    applicationKey,
    scheduledInput,
    200,
    { "idempotency-key": idempotencyKey },
  );
  const replayedScheduled = await api(
    "POST",
    "/emails",
    applicationKey,
    scheduledInput,
    200,
    { "idempotency-key": idempotencyKey },
  );
  assert.equal(replayedScheduled.id, scheduled.id);
  created.emailId = scheduled.id;
  recoveryEmailId = scheduled.id;

  const retrieved = await api(
    "GET",
    `/emails/${created.emailId}`,
    applicationKey,
  );
  assert.equal(retrieved.status, "scheduled");
  assert.equal(retrieved.text, privateBody);
  assert.deepEqual(retrieved.attachments, [
    {
      attachment_id: upload.id,
      filename: "integration.txt",
      content_type: "text/plain",
    },
  ]);
  const retrievedJson = JSON.stringify(retrieved);
  assert.equal(retrievedJson.includes(checksum), false);
  assert.equal(retrievedJson.includes("object_key"), false);
  assert.equal(
    retrievedJson.includes(attachmentContent.toString("base64")),
    false,
  );

  await api(
    "GET",
    `/emails/${created.emailId}/recipients`,
    sendOnlyKey.token,
    undefined,
    403,
  );
  const firstRecipientPage = await api(
    "GET",
    `/emails/${created.emailId}/recipients?limit=1`,
    applicationKey,
  );
  assert.equal(firstRecipientPage.object, "list");
  assert.equal(firstRecipientPage.message_id, created.emailId);
  assert.equal(firstRecipientPage.aggregate_status, "queued");
  assert.equal(firstRecipientPage.recipient_count, 2);
  assert.equal(firstRecipientPage.has_more, true);
  assert.match(firstRecipientPage.next_cursor, /^rcpt_[A-Za-z0-9_-]{22,128}$/);
  assert.equal(firstRecipientPage.data.length, 1);
  assert.deepEqual(
    {
      id: firstRecipientPage.data[0].id,
      role: firstRecipientPage.data[0].role,
      ordinal: firstRecipientPage.data[0].ordinal,
      status: firstRecipientPage.data[0].status,
      recovery_state: firstRecipientPage.data[0].recovery_state,
      requires_operator_attention:
        firstRecipientPage.data[0].requires_operator_attention,
      latest_attempt: firstRecipientPage.data[0].latest_attempt,
    },
    {
      id: firstRecipientPage.next_cursor,
      role: "to",
      ordinal: 0,
      status: "queued",
      recovery_state: "pending",
      requires_operator_attention: false,
      latest_attempt: null,
    },
  );
  assertPrivateValuesAbsent(firstRecipientPage, [
    ...privateRecipients,
    privateSubject,
    privateBody,
    "sender@example.com",
  ]);
  assertForbiddenFieldsAbsent(firstRecipientPage, PRIVATE_DIAGNOSTIC_FIELDS);
  const secondRecipientPage = await api(
    "GET",
    `/emails/${created.emailId}/recipients?limit=1&after=${encodeURIComponent(
      firstRecipientPage.next_cursor,
    )}`,
    applicationKey,
  );
  assert.equal(secondRecipientPage.message_id, created.emailId);
  assert.equal(secondRecipientPage.recipient_count, 2);
  assert.equal(secondRecipientPage.has_more, false);
  assert.equal("next_cursor" in secondRecipientPage, false);
  assert.equal(secondRecipientPage.data.length, 1);
  assert.match(secondRecipientPage.data[0].id, /^rcpt_[A-Za-z0-9_-]{22,128}$/);
  assert.notEqual(
    secondRecipientPage.data[0].id,
    firstRecipientPage.data[0].id,
  );
  assert.deepEqual(
    {
      role: secondRecipientPage.data[0].role,
      ordinal: secondRecipientPage.data[0].ordinal,
      status: secondRecipientPage.data[0].status,
      recovery_state: secondRecipientPage.data[0].recovery_state,
      requires_operator_attention:
        secondRecipientPage.data[0].requires_operator_attention,
      latest_attempt: secondRecipientPage.data[0].latest_attempt,
    },
    {
      role: "to",
      ordinal: 1,
      status: "queued",
      recovery_state: "pending",
      requires_operator_attention: false,
      latest_attempt: null,
    },
  );
  assertPrivateValuesAbsent(secondRecipientPage, [
    ...privateRecipients,
    privateSubject,
    privateBody,
    "sender@example.com",
  ]);
  assertForbiddenFieldsAbsent(secondRecipientPage, PRIVATE_DIAGNOSTIC_FIELDS);

  const recoveryDiagnostics = await api(
    "GET",
    "/diagnostics/recovery",
    applicationKey,
  );
  assert.equal(recoveryDiagnostics.object, "recovery_diagnostics");
  assert.equal(recoveryDiagnostics.queues.provider, "aws-sqs");
  assertQueueDepth(recoveryDiagnostics.queues.primary);
  assertQueueDepth(recoveryDiagnostics.queues.dead_letters.delivery);
  assertQueueDepth(recoveryDiagnostics.queues.dead_letters.scheduler);
  assert.equal(recoveryDiagnostics.queues.dead_letters.inbound, null);
  for (const name of [
    "due",
    "leased",
    "stuck_leases",
    "undispatched",
    "oldest_due_age_seconds",
    "publish_failures_total",
  ]) {
    assert.ok(
      Number.isSafeInteger(recoveryDiagnostics.outbox[name]) &&
        recoveryDiagnostics.outbox[name] >= 0,
      `${name} must be a non-negative safe integer.`,
    );
  }
  assert.ok(recoveryDiagnostics.outbox.undispatched >= 1);
  assert.equal(typeof recoveryDiagnostics.outbox.truncated, "boolean");
  assert.equal(recoveryDiagnostics.provider_events.latest_received_at, null);
  assert.equal(recoveryDiagnostics.provider_events.lag_seconds, null);
  assert.equal(recoveryDiagnostics.capability.provider, "aws-ses");
  assert.equal(recoveryDiagnostics.capability.adapter_version, health.version);
  assert.equal(recoveryDiagnostics.capability.capability_version, "1.0.0");
  assert.match(
    recoveryDiagnostics.capability.document_sha256,
    /^[a-f0-9]{64}$/,
  );
  assertPrivateValuesAbsent(recoveryDiagnostics, [
    ...privateRecipients,
    privateSubject,
    privateBody,
    "sender@example.com",
  ]);
  assertForbiddenFieldsAbsent(recoveryDiagnostics, PRIVATE_DIAGNOSTIC_FIELDS);

  await api("PATCH", `/emails/${created.emailId}`, applicationKey, {
    scheduled_at: "in 25 minutes",
  });
  await api("POST", `/emails/${created.emailId}/cancel`, applicationKey);
  const canceled = await api(
    "GET",
    `/emails/${created.emailId}`,
    applicationKey,
  );
  assert.equal(canceled.status, "canceled");
  created.emailId = undefined;

  created.suppressionEmail = `blocked-${runId}@example.net`;
  await api("POST", "/suppressions", applicationKey, {
    email: created.suppressionEmail,
    reason: "manual",
    detail: "AWS integration test",
  });
  const suppressedSend = await api("POST", "/emails", applicationKey, {
    from: "HayaSend Integration <sender@example.com>",
    to: created.suppressionEmail,
    subject: `Suppression integration ${runId}`,
    text: "This message must never be queued.",
  });
  const suppressed = await api(
    "GET",
    `/emails/${suppressedSend.id}`,
    applicationKey,
  );
  assert.equal(suppressed.status, "suppressed");

  const domainName = `it-${runId}.example.com`;
  const domain = await api("POST", "/domains", applicationKey, {
    name: domainName,
  });
  created.domainId = domain.id;
  assert.equal(domain.name, domainName);
  const duplicateDomain = await api(
    "POST",
    "/domains",
    applicationKey,
    { name: `${domainName.toUpperCase()}.` },
    403,
  );
  assert.deepEqual(duplicateDomain, {
    statusCode: 403,
    name: "validation_error",
    message: `The \`${domainName}\` domain has been registered already.`,
  });
  await api("POST", `/domains/${created.domainId}/verify`, applicationKey);

  const webhook = await api("POST", "/webhooks", applicationKey, {
    endpoint: `${baseUrl}/healthz`,
    events: ["email.received"],
  });
  created.webhookId = webhook.id;
  assert.match(webhook.signing_secret, /^whsec_/);
  const updatedWebhook = await api(
    "PATCH",
    `/webhooks/${created.webhookId}`,
    applicationKey,
    { status: "disabled" },
  );
  assert.equal(updatedWebhook.id, created.webhookId);
  const publicWebhook = await api(
    "GET",
    `/webhooks/${created.webhookId}`,
    applicationKey,
  );
  assert.equal("signing_secret" in publicWebhook, false);
  assert.equal(publicWebhook.status, "disabled");
  const webhookDeliveries = await api(
    "GET",
    `/webhooks/${created.webhookId}/deliveries?limit=1`,
    applicationKey,
  );
  assert.equal(webhookDeliveries.object, "list");
  assert.deepEqual(webhookDeliveries.data, []);

  console.info(
    JSON.stringify({
      ok: true,
      service: "hayasend",
      recovery_email_id: recoveryEmailId,
      backup_probe: {
        email_id: recoveryEmailId,
        attachment_id: upload.id,
        attachment_sha256: checksum,
      },
      checks: [
        "health",
        "scoped_api_keys",
        "direct_attachment_upload",
        "api_plain_text_fallback",
        "schedule_reschedule_cancel",
        "idempotency_replay",
        "public_attachment_privacy",
        "recipient_summary_scope",
        "recipient_summary_pagination",
        "recipient_summary_privacy",
        "recovery_diagnostics_scope",
        "recovery_diagnostics_outbox",
        "recovery_diagnostics_sqs_and_dlqs",
        "recovery_diagnostics_capability_digest",
        "recovery_diagnostics_privacy",
        "suppression",
        "ses_domain_identity",
        "ses_duplicate_domain_error",
        "webhook_public_endpoint_validation",
        "webhook_update",
        "webhook_delivery_history",
        "webhook_secret_privacy",
      ],
      recipient_summary: {
        recipient_count: firstRecipientPage.recipient_count,
        aggregate_status: firstRecipientPage.aggregate_status,
        opaque_ids: true,
        private_fields_absent: true,
      },
      recovery_diagnostics: {
        provider: recoveryDiagnostics.capability.provider,
        queue_provider: recoveryDiagnostics.queues.provider,
        outbox_undispatched_at_least_one:
          recoveryDiagnostics.outbox.undispatched >= 1,
        delivery_dlq_reported:
          recoveryDiagnostics.queues.dead_letters.delivery !== null,
        scheduler_dlq_reported:
          recoveryDiagnostics.queues.dead_letters.scheduler !== null,
        inbound_dlq_disabled:
          recoveryDiagnostics.queues.dead_letters.inbound === null,
        capability_document_sha256:
          recoveryDiagnostics.capability.document_sha256,
        private_fields_absent: true,
      },
    }),
  );
} finally {
  if (applicationKey && created.emailId) {
    await bestEffort("scheduled email", () =>
      api("POST", `/emails/${created.emailId}/cancel`, applicationKey),
    );
  }
  if (applicationKey && created.webhookId) {
    await bestEffort("webhook", () =>
      api("DELETE", `/webhooks/${created.webhookId}`, applicationKey),
    );
  }
  if (applicationKey && created.domainId) {
    await bestEffort("SES domain identity", () =>
      api("DELETE", `/domains/${created.domainId}`, applicationKey),
    );
  }
  if (applicationKey && created.suppressionEmail) {
    await bestEffort("suppression", () =>
      api(
        "DELETE",
        `/suppressions/${encodeURIComponent(created.suppressionEmail)}`,
        applicationKey,
      ),
    );
  }
  for (const apiKeyId of created.apiKeyIds.reverse()) {
    await bestEffort("an API key", () =>
      api("DELETE", `/api-keys/${apiKeyId}`, bootstrapKey),
    );
  }
}
