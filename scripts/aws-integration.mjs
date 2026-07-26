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
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
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

const created = {
  apiKeyIds: [],
  domainId: undefined,
  emailId: undefined,
  suppressionEmail: undefined,
  webhookId: undefined,
};
let applicationKey;

try {
  const health = await api("GET", "/healthz", undefined);
  assert.equal(health.ok, true);
  assert.equal(health.service, "hayasend");

  const fullKey = await api("POST", "/api-keys", bootstrapKey, {
    name: `aws-integration-${runId}`,
    scopes: [
      "emails:send",
      "emails:read",
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

  const attachmentContent = Buffer.from(
    `HayaSend AWS integration attachment ${runId}`,
  );
  const checksum = createHash("sha256")
    .update(attachmentContent)
    .digest("hex");
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

  const scheduled = await api("POST", "/emails", applicationKey, {
    from: "HayaSend Integration <sender@example.com>",
    to: "recipient@example.net",
    subject: `AWS integration ${runId}`,
    text: "This message is canceled by the integration test.",
    scheduled_at: "in 20 minutes",
    attachments: [{ attachment_id: upload.id }],
  });
  created.emailId = scheduled.id;

  const retrieved = await api(
    "GET",
    `/emails/${created.emailId}`,
    applicationKey,
  );
  assert.equal(retrieved.status, "scheduled");
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
    "PATCH",
    `/emails/${created.emailId}`,
    applicationKey,
    { scheduled_at: "in 25 minutes" },
  );
  await api(
    "POST",
    `/emails/${created.emailId}/cancel`,
    applicationKey,
  );
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

  const domain = await api("POST", "/domains", applicationKey, {
    name: `it-${runId}.example.com`,
  });
  created.domainId = domain.id;
  assert.equal(domain.name, `it-${runId}.example.com`);
  await api(
    "POST",
    `/domains/${created.domainId}/verify`,
    applicationKey,
  );

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
      checks: [
        "health",
        "scoped_api_keys",
        "direct_attachment_upload",
        "schedule_reschedule_cancel",
        "public_attachment_privacy",
        "suppression",
        "ses_domain_identity",
        "webhook_public_endpoint_validation",
        "webhook_update",
        "webhook_delivery_history",
        "webhook_secret_privacy",
      ],
    }),
  );
} finally {
  if (applicationKey && created.emailId) {
    await bestEffort("scheduled email", () =>
      api(
        "POST",
        `/emails/${created.emailId}/cancel`,
        applicationKey,
      ),
    );
  }
  if (applicationKey && created.webhookId) {
    await bestEffort("webhook", () =>
      api(
        "DELETE",
        `/webhooks/${created.webhookId}`,
        applicationKey,
      ),
    );
  }
  if (applicationKey && created.domainId) {
    await bestEffort("SES domain identity", () =>
      api(
        "DELETE",
        `/domains/${created.domainId}`,
        applicationKey,
      ),
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
