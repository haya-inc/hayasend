#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const API_VERSION = "2025-02-15";
const MANAGEMENT_ORIGIN = "https://management.azure.com";
const EVENT_TYPES = [
  "Microsoft.Communication.EmailDeliveryReportReceived",
  "Microsoft.Communication.EmailEngagementTrackingReportReceived",
];

function fail(message) {
  throw new Error(message);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    fail(`${name} is required.`);
  }
  return value;
}

function azureJson(args) {
  const result = spawnSync(
    "az",
    [...args, "--only-show-errors", "--output", "json"],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    fail(`Azure CLI failed for ${args.slice(0, 2).join(" ")}.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Azure CLI returned invalid JSON for ${args.slice(0, 2).join(" ")}.`);
  }
}

function validateUuid(value, label) {
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  ) {
    fail(`${label} must be an Azure UUID.`);
  }
}

function inputs(requiresSecret) {
  const subscriptionId = requiredEnvironment(
    "HAYASEND_AZURE_SUBSCRIPTION_ID",
  );
  const tenantId = requiredEnvironment("HAYASEND_AZURE_TENANT_ID");
  const scope = requiredEnvironment("HAYASEND_AZURE_EVENT_SCOPE");
  const subscriptionName = requiredEnvironment(
    "HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME",
  );
  const apiUrl = new URL(requiredEnvironment("HAYASEND_AZURE_API_URL"));
  const deploymentId = requiredEnvironment("HAYASEND_AZURE_DEPLOYMENT_ID");

  validateUuid(subscriptionId, "HAYASEND_AZURE_SUBSCRIPTION_ID");
  validateUuid(tenantId, "HAYASEND_AZURE_TENANT_ID");
  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash ||
    apiUrl.pathname !== "/"
  ) {
    fail("HAYASEND_AZURE_API_URL must be a credential-free HTTPS origin.");
  }
  const scopeMatch =
    /^\/subscriptions\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/resourceGroups\/[A-Za-z0-9_().-]{1,90}\/providers\/Microsoft\.Communication\/communicationServices\/[A-Za-z0-9-]{1,63}$/i.exec(
      scope,
    );
  if (
    !scopeMatch ||
    scopeMatch[1].toLowerCase() !== subscriptionId.toLowerCase()
  ) {
    fail("HAYASEND_AZURE_EVENT_SCOPE must be an ACS resource in the selected subscription.");
  }
  if (!/^[A-Za-z0-9]{3,64}$/.test(subscriptionName)) {
    fail("HAYASEND_AZURE_EVENT_SUBSCRIPTION_NAME must be 3-64 alphanumeric characters.");
  }
  if (!/^[a-f0-9]{12}$/.test(deploymentId)) {
    fail("HAYASEND_AZURE_DEPLOYMENT_ID must be the Terraform deployment ID.");
  }

  let secret;
  if (requiresSecret) {
    secret = requiredEnvironment("HAYASEND_AZURE_EVENT_GRID_SECRET");
    if (
      secret.length < 32 ||
      secret.length > 512 ||
      /[\r\n\u0000]/u.test(secret)
    ) {
      fail("HAYASEND_AZURE_EVENT_GRID_SECRET must be a single-line 32-512 character secret.");
    }
  }

  return {
    apiUrl,
    deploymentId,
    scope,
    secret,
    subscriptionId,
    subscriptionName,
    tenantId,
  };
}

function assertAzureAccount({ subscriptionId, tenantId }) {
  const account = azureJson(["account", "show"]);
  if (
    String(account.id).toLowerCase() !== subscriptionId.toLowerCase() ||
    String(account.tenantId).toLowerCase() !== tenantId.toLowerCase()
  ) {
    fail("Azure CLI is not authenticated to the exact configured subscription and tenant.");
  }
}

function managementToken() {
  const token = azureJson([
    "account",
    "get-access-token",
    "--resource",
    "https://management.azure.com/",
  ]).accessToken;
  if (typeof token !== "string" || token.length < 32) {
    fail("Azure CLI did not return a management-plane access token.");
  }
  return token;
}

function resourceUrl({ scope, subscriptionName }, suffix = "") {
  return (
    `https://management.azure.com${scope}` +
    `/providers/Microsoft.EventGrid/eventSubscriptions/` +
    `${encodeURIComponent(subscriptionName)}${suffix}?api-version=${API_VERSION}`
  );
}

async function request(url, token, options = {}) {
  const managementUrl = new URL(url);
  if (
    managementUrl.origin !== MANAGEMENT_ORIGIN ||
    managementUrl.username ||
    managementUrl.password ||
    managementUrl.port
  ) {
    fail("Azure management request must use the fixed HTTPS management origin.");
  }
  const response = await fetch(managementUrl, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  return response;
}

async function readSubscription(config, token) {
  const response = await request(resourceUrl(config), token);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    fail(`Event Grid read failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function readDeliveryAttributes(config, token) {
  const response = await request(
    resourceUrl(config, "/getDeliveryAttributes"),
    token,
    { method: "POST" },
  );
  if (!response.ok) {
    fail(`Event Grid delivery-attribute read failed with HTTP ${response.status}.`);
  }
  const body = await response.json();
  return Array.isArray(body?.value) ? body.value : [];
}

async function readFullUrl(config, token) {
  const response = await request(resourceUrl(config, "/getFullUrl"), token, {
    method: "POST",
  });
  if (!response.ok) {
    fail(`Event Grid full-URL read failed with HTTP ${response.status}.`);
  }
  const body = await response.json();
  if (typeof body?.endpointUrl !== "string") {
    fail("Event Grid full-URL response did not contain an endpoint URL.");
  }
  return body.endpointUrl;
}

function verifySubscription(
  config,
  subscription,
  deliveryAttributes,
  fullUrl,
) {
  const properties = subscription?.properties;
  const destination = properties?.destination;
  const expectedEndpoint = new URL("/events/azure-email", config.apiUrl).href;
  const eventTypes = properties?.filter?.includedEventTypes ?? [];
  const mapping = deliveryAttributes.find(
    (entry) =>
      String(entry?.name).toLowerCase() ===
      "x-hayasend-event-grid-secret",
  );

  if (String(properties?.provisioningState).toLowerCase() !== "succeeded") {
    fail("Event Grid subscription has not reached Succeeded.");
  }
  if (String(properties?.topic).toLowerCase() !== config.scope.toLowerCase()) {
    fail("Event Grid subscription topic does not match the exact ACS resource.");
  }
  if (fullUrl !== expectedEndpoint) {
    fail("Event Grid webhook endpoint does not match the HayaSend API.");
  }
  if (destination?.properties?.minimumTlsVersionAllowed !== "1.2") {
    fail("Event Grid webhook must require TLS 1.2.");
  }
  if (
    EVENT_TYPES.some((eventType) => !eventTypes.includes(eventType)) ||
    eventTypes.some((eventType) => !EVENT_TYPES.includes(eventType))
  ) {
    fail("Event Grid subscription event types do not match the reviewed set.");
  }
  if (
    mapping?.type !== "Static" ||
    mapping?.properties?.isSecret !== true
  ) {
    fail("Event Grid custom header is absent or is not protected as a secret.");
  }
  if (
    properties?.retryPolicy?.maxDeliveryAttempts !== 30 ||
    properties?.retryPolicy?.eventTimeToLiveInMinutes !== 1440
  ) {
    fail("Event Grid retry and retention policy does not match the reviewed values.");
  }
  if (
    !properties?.labels?.includes("hayasend") ||
    !properties?.labels?.includes(`deployment-${config.deploymentId}`)
  ) {
    fail("Event Grid subscription labels do not match this deployment.");
  }
}

async function ensure(config, token) {
  const endpointUrl = new URL("/events/azure-email", config.apiUrl).href;
  const body = {
    properties: {
      destination: {
        endpointType: "WebHook",
        properties: {
          deliveryAttributeMappings: [
            {
              name: "x-hayasend-event-grid-secret",
              type: "Static",
              properties: {
                isSecret: true,
                value: config.secret,
              },
            },
          ],
          endpointUrl,
          maxEventsPerBatch: 1,
          minimumTlsVersionAllowed: "1.2",
          preferredBatchSizeInKilobytes: 64,
        },
      },
      eventDeliverySchema: "EventGridSchema",
      filter: {
        includedEventTypes: EVENT_TYPES,
        isSubjectCaseSensitive: false,
      },
      labels: ["hayasend", `deployment-${config.deploymentId}`],
      retryPolicy: {
        eventTimeToLiveInMinutes: 1440,
        maxDeliveryAttempts: 30,
      },
    },
  };

  const response = await request(resourceUrl(config), token, {
    body: JSON.stringify(body),
    method: "PUT",
  });
  if (![200, 201, 202].includes(response.status)) {
    fail(`Event Grid create/update failed with HTTP ${response.status}.`);
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const subscription = await readSubscription(config, token);
    if (
      String(subscription?.properties?.provisioningState).toLowerCase() ===
      "succeeded"
    ) {
      const deliveryAttributes = await readDeliveryAttributes(config, token);
      const fullUrl = await readFullUrl(config, token);
      verifySubscription(config, subscription, deliveryAttributes, fullUrl);
      process.stdout.write(
        `Event Grid subscription ${config.subscriptionName} is ready.\n`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail("Event Grid subscription did not become ready within 60 seconds.");
}

async function verify(config, token) {
  const subscription = await readSubscription(config, token);
  if (!subscription) {
    fail("Event Grid subscription does not exist.");
  }
  const deliveryAttributes = await readDeliveryAttributes(config, token);
  const fullUrl = await readFullUrl(config, token);
  verifySubscription(config, subscription, deliveryAttributes, fullUrl);
  process.stdout.write(
    `Event Grid subscription ${config.subscriptionName} is verified.\n`,
  );
}

async function remove(config, token) {
  const response = await request(resourceUrl(config), token, {
    method: "DELETE",
  });
  if (![200, 202, 204, 404].includes(response.status)) {
    fail(`Event Grid delete failed with HTTP ${response.status}.`);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await readSubscription(config, token)) === null) {
      process.stdout.write(
        `Event Grid subscription ${config.subscriptionName} is absent.\n`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail("Event Grid subscription still exists after 60 seconds.");
}

function authenticatedConfig(requiresSecret) {
  const config = inputs(requiresSecret);
  assertAzureAccount(config);
  return { config, token: managementToken() };
}

export async function ensureFromEnvironment() {
  const { config, token } = authenticatedConfig(true);
  await ensure(config, token);
}

export async function verifyFromEnvironment() {
  const { config, token } = authenticatedConfig(false);
  await verify(config, token);
}

export async function deleteFromEnvironment() {
  const { config, token } = authenticatedConfig(false);
  await remove(config, token);
}
