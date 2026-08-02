import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import {
  resolvePortableCapabilityProfiles,
  type PortableDeploymentProfile,
  type PortableRuntimeProfile,
} from "./capability-profiles.js";
import { ValidationError } from "./core/errors.js";

export const CONSOLE_PROOF_CONFIRMATION = "isolated-non-sending";

export interface Config {
  mode: "local" | "aws" | "portable";
  apiKey?: string;
  apiKeySecretArn?: string;
  consoleAuthOrigin?: string;
  consoleAuthGoogleClientId?: string;
  consoleAuthAllowedEmails?: string[];
  consoleAuthCredentials?: string;
  consoleAuthSecretArn?: string;
  host: string;
  port: number;
  region: string;
  tableName?: string;
  queueUrl?: string;
  queueArn?: string;
  deliveryDeadLetterQueueUrl?: string;
  schedulerDeadLetterQueueUrl?: string;
  inboundDeadLetterQueueUrl?: string;
  payloadBucket?: string;
  configurationSet?: string;
  schedulerGroupName?: string;
  schedulerRoleArn?: string;
  schedulerDeadLetterQueueArn?: string;
  inboundBucket?: string;
  inboundRawPrefix: string;
  inboundRetentionDays: number;
  inboundMaxMessageBytes: number;
  webhookDeliveryRetentionDays: number;
  templateHistoryRetentionDays: number;
  templateHistoryLimit: number;
  databaseUrl?: string;
  portableTransport?:
    | "console"
    | "aws-ses"
    | "azure-communication-services"
    | "sendgrid";
  portableRuntimeProfile?: PortableRuntimeProfile;
  portableDeploymentProfile?: PortableDeploymentProfile;
  portableObjectStorage?:
    | "disabled"
    | "s3"
    | "gcs"
    | "azure-blob"
    | "vercel-blob";
  portableQueueWakeup?: "disabled" | "gcp-pubsub";
  gcpPubSubTopic?: string;
  gcpPubSubSubscription?: string;
  objectStorageBucket?: string;
  vercelBlobToken?: string;
  s3Endpoint?: string;
  s3ForcePathStyle?: boolean;
  gcsProjectId?: string;
  azureStorageAccount?: string;
  azureBlobEndpoint?: string;
  azureCommunicationEmailEndpoint?: string;
  azureSubscriptionId?: string;
  azureResourceGroup?: string;
  azureCommunicationServiceName?: string;
  azureEmailServiceName?: string;
  azureEmailDomainResourceName?: string;
  azureEventGridSecret?: string;
  sendGridApiKey?: string;
  sendGridApiBaseUrl?: string;
  sendGridEventWebhookPublicKey?: string;
  postgresPoolMax?: number;
  postgresIdleTimeoutMs?: number;
  postgresConnectionTimeoutMs?: number;
  postgresMaxLifetimeSeconds?: number;
  workerConcurrency?: number;
  workerLeaseSeconds?: number;
  workerPollIntervalMs?: number;
  workerRetryDelaySeconds?: number;
  workerOutboxIntervalMs?: number;
  jobMaxAttempts?: number;
  jobRetentionDays?: number;
}

const MAX_SECRET_FILE_BYTES = 16 * 1024;

function secretSetting(env: NodeJS.ProcessEnv, name: string) {
  const direct = env[name];
  const fileName = `${name}_FILE`;
  const path = env[fileName];
  if (direct !== undefined && path !== undefined) {
    throw new ValidationError(
      `${name} and ${fileName} may not both be set.`,
    );
  }
  if (path === undefined) {
    return direct;
  }
  if (
    !isAbsolute(path) ||
    path.length > 4_096 ||
    path.includes("\0")
  ) {
    throw new ValidationError(
      `${fileName} must be an absolute secret-file path.`,
    );
  }
  let descriptor: number | undefined;
  let value: string;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_FILE_BYTES
    ) {
      throw new Error("invalid secret file");
    }
    const content = Buffer.allocUnsafe(MAX_SECRET_FILE_BYTES + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesRead = readSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        null,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > MAX_SECRET_FILE_BYTES) {
      throw new Error("invalid secret file");
    }
    value = content.subarray(0, offset).toString("utf8");
  } catch {
    throw new ValidationError(
      `${fileName} must reference a readable regular file of at most ${MAX_SECRET_FILE_BYTES} bytes.`,
    );
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  value = value.replace(/\r?\n$/, "");
  if (!value || /[\r\n\0]/.test(value)) {
    throw new ValidationError(
      `${fileName} must contain exactly one non-empty secret value.`,
    );
  }
  return value;
}

function publicMultilineSetting(env: NodeJS.ProcessEnv, name: string) {
  const direct = env[name];
  const fileName = `${name}_FILE`;
  const path = env[fileName];
  if (direct !== undefined && path !== undefined) {
    throw new ValidationError(
      `${name} and ${fileName} may not both be set.`,
    );
  }
  if (path === undefined) {
    return direct?.trim();
  }
  if (
    !isAbsolute(path) ||
    path.length > 4_096 ||
    path.includes("\0")
  ) {
    throw new ValidationError(
      `${fileName} must be an absolute configuration-file path.`,
    );
  }
  let descriptor: number | undefined;
  let value: string;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_FILE_BYTES
    ) {
      throw new Error("invalid configuration file");
    }
    const content = Buffer.allocUnsafe(MAX_SECRET_FILE_BYTES + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesRead = readSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        null,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > MAX_SECRET_FILE_BYTES) {
      throw new Error("invalid configuration file");
    }
    value = content.subarray(0, offset).toString("utf8").trim();
  } catch {
    throw new ValidationError(
      `${fileName} must reference a readable regular file of at most ${MAX_SECRET_FILE_BYTES} bytes.`,
    );
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  return value;
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(env[name] ?? fallback);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function booleanSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
) {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  if (!["true", "false"].includes(value)) {
    throw new ValidationError(`${name} must be true or false.`);
  }
  return value === "true";
}

function secureServiceEndpoint(value: string, name: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ValidationError(`${name} must be an absolute URL.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpoint.hostname,
  );
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    (endpoint.protocol === "http:" && !loopback) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  ) {
    throw new ValidationError(
      `${name} must be an HTTPS service origin (HTTP is allowed only for loopback emulators).`,
    );
  }
  return endpoint.origin;
}

function consoleAuthEmails(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const emails = [
    ...new Set(
      value
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (
    emails.length === 0 ||
    emails.length > 50 ||
    emails.some(
      (email) =>
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    )
  ) {
    throw new ValidationError(
      "HAYASEND_CONSOLE_AUTH_ALLOWED_EMAILS must contain 1 to 50 comma-separated email addresses.",
    );
  }
  return emails;
}

export function loadConfig(env = process.env): Config {
  const requestedMode = env.HAYASEND_MODE ?? "local";
  if (!["local", "aws", "portable"].includes(requestedMode)) {
    throw new ValidationError(
      "HAYASEND_MODE must be local, aws, or portable.",
    );
  }
  const mode = requestedMode as Config["mode"];
  const configuredApiKey = secretSetting(env, "HAYASEND_API_KEY");
  const apiKey =
    configuredApiKey ??
    (mode === "local" ? "re_hayasend_dev" : undefined);
  const apiKeySecretArn = env.HAYASEND_API_KEY_SECRET_ARN;
  if (mode === "aws" && !apiKeySecretArn) {
    throw new ValidationError(
      "HAYASEND_API_KEY_SECRET_ARN is required in AWS mode.",
    );
  }
  if (mode === "aws" && apiKey) {
    throw new ValidationError(
      "HAYASEND_API_KEY is not supported in AWS mode; use Secrets Manager.",
    );
  }
  const consoleAuthOriginValue = env.HAYASEND_CONSOLE_AUTH_ORIGIN;
  const consoleAuthOrigin = consoleAuthOriginValue
    ? secureServiceEndpoint(
        consoleAuthOriginValue,
        "HAYASEND_CONSOLE_AUTH_ORIGIN",
      )
    : undefined;
  const consoleAuthGoogleClientId =
    env.HAYASEND_CONSOLE_AUTH_GOOGLE_CLIENT_ID?.trim();
  const consoleAuthAllowedEmails = consoleAuthEmails(
    env.HAYASEND_CONSOLE_AUTH_ALLOWED_EMAILS,
  );
  const consoleAuthCredentials = secretSetting(
    env,
    "HAYASEND_CONSOLE_AUTH_CREDENTIALS",
  );
  const consoleAuthSecretArn = env.HAYASEND_CONSOLE_AUTH_SECRET_ARN;
  if (consoleAuthCredentials && consoleAuthSecretArn) {
    throw new ValidationError(
      "HAYASEND_CONSOLE_AUTH_CREDENTIALS and HAYASEND_CONSOLE_AUTH_SECRET_ARN may not both be set.",
    );
  }
  const consoleAuthConfigured = Boolean(
    consoleAuthOrigin ||
      consoleAuthGoogleClientId ||
      consoleAuthAllowedEmails ||
      consoleAuthCredentials ||
      consoleAuthSecretArn,
  );
  if (
    consoleAuthConfigured &&
    (!consoleAuthOrigin ||
      !consoleAuthGoogleClientId ||
      !consoleAuthAllowedEmails ||
      (!consoleAuthCredentials && !consoleAuthSecretArn))
  ) {
    throw new ValidationError(
      "Console authentication requires HAYASEND_CONSOLE_AUTH_ORIGIN, HAYASEND_CONSOLE_AUTH_GOOGLE_CLIENT_ID, HAYASEND_CONSOLE_AUTH_ALLOWED_EMAILS, and one credentials source.",
    );
  }
  if (
    consoleAuthGoogleClientId &&
    (consoleAuthGoogleClientId.length > 512 ||
      /[\s\r\n\0]/.test(consoleAuthGoogleClientId))
  ) {
    throw new ValidationError(
      "HAYASEND_CONSOLE_AUTH_GOOGLE_CLIENT_ID must be a valid OAuth client ID.",
    );
  }
  if (mode === "aws" && consoleAuthCredentials) {
    throw new ValidationError(
      "HAYASEND_CONSOLE_AUTH_CREDENTIALS is not supported in AWS mode; use Secrets Manager.",
    );
  }
  if (mode !== "aws" && consoleAuthSecretArn) {
    throw new ValidationError(
      "HAYASEND_CONSOLE_AUTH_SECRET_ARN is supported only in AWS mode.",
    );
  }
  const databaseUrl = secretSetting(env, "HAYASEND_DATABASE_URL");
  if (mode === "portable") {
    if (!databaseUrl) {
      throw new ValidationError(
        "HAYASEND_DATABASE_URL is required in portable mode.",
      );
    }
    let protocol = "";
    try {
      protocol = new URL(databaseUrl).protocol;
    } catch {
      // The public error deliberately excludes the credential-bearing value.
    }
    if (!["postgres:", "postgresql:"].includes(protocol)) {
      throw new ValidationError(
        "HAYASEND_DATABASE_URL must be a PostgreSQL connection URL.",
      );
    }
    if (
      !apiKey ||
      apiKey.length < 16 ||
      apiKey.length > 512 ||
      !apiKey.startsWith("re_")
    ) {
      throw new ValidationError(
        "HAYASEND_API_KEY must be a 16 to 512 character re_ key in portable mode.",
      );
    }
  }
  const portableTransport = env.HAYASEND_TRANSPORT;
  if (
    mode === "portable" &&
    ![
      "console",
      "aws-ses",
      "azure-communication-services",
      "sendgrid",
    ].includes(portableTransport ?? "")
  ) {
    throw new ValidationError(
      "HAYASEND_TRANSPORT must be console, aws-ses, azure-communication-services, or sendgrid in portable mode.",
    );
  }
  const portableCapabilityProfiles =
    mode === "portable"
      ? resolvePortableCapabilityProfiles({
          runtime: env.HAYASEND_RUNTIME_PROFILE,
          deployment: env.HAYASEND_DEPLOYMENT_PROFILE,
          transport: portableTransport as
            | "console"
            | "aws-ses"
            | "azure-communication-services"
            | "sendgrid",
        })
      : undefined;
  const usesAcs = portableTransport === "azure-communication-services";
  const azureCommunicationEmailEndpoint =
    env.AZURE_COMMUNICATION_EMAIL_ENDPOINT
      ? secureServiceEndpoint(
          env.AZURE_COMMUNICATION_EMAIL_ENDPOINT,
          "AZURE_COMMUNICATION_EMAIL_ENDPOINT",
        )
      : undefined;
  const azureSubscriptionId = env.AZURE_SUBSCRIPTION_ID;
  const azureResourceGroup = env.AZURE_RESOURCE_GROUP;
  const azureCommunicationServiceName =
    env.AZURE_COMMUNICATION_SERVICE_NAME;
  const azureEmailServiceName = env.AZURE_EMAIL_SERVICE_NAME;
  const azureEmailDomainResourceName =
    env.AZURE_EMAIL_DOMAIN_RESOURCE_NAME;
  const azureEventGridSecret = secretSetting(
    env,
    "HAYASEND_AZURE_EVENT_GRID_SECRET",
  );
  if (
    azureEventGridSecret !== undefined &&
    (azureEventGridSecret.length < 32 ||
      azureEventGridSecret.length > 512)
  ) {
    throw new ValidationError(
      "HAYASEND_AZURE_EVENT_GRID_SECRET must contain 32 to 512 characters.",
    );
  }
  if (
    mode === "portable" &&
    usesAcs &&
    (!azureCommunicationEmailEndpoint ||
      !azureSubscriptionId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        azureSubscriptionId,
      ) ||
      !azureResourceGroup ||
      !/^[A-Za-z0-9_().-]{1,90}$/.test(azureResourceGroup) ||
      azureResourceGroup.endsWith(".") ||
      !azureCommunicationServiceName ||
      !/^[A-Za-z0-9-]{1,63}$/.test(
        azureCommunicationServiceName,
      ) ||
      !azureEmailServiceName ||
      !/^[A-Za-z0-9-]{1,63}$/.test(azureEmailServiceName) ||
      !azureEmailDomainResourceName ||
      azureEmailDomainResourceName.length > 253 ||
      !/^[A-Za-z0-9.-]+$/.test(azureEmailDomainResourceName))
  ) {
    throw new ValidationError(
      "Azure Communication Services transport requires a safe endpoint, subscription ID, resource group, Communication Services name, Email Services name, and domain resource name.",
    );
  }
  const usesSendGrid = portableTransport === "sendgrid";
  const sendGridApiKey = secretSetting(env, "SENDGRID_API_KEY");
  if (
    mode === "portable" &&
    usesSendGrid &&
    (!sendGridApiKey ||
      sendGridApiKey.length < 32 ||
      sendGridApiKey.length > 512 ||
      !sendGridApiKey.startsWith("SG."))
  ) {
    throw new ValidationError(
      "SENDGRID_API_KEY or SENDGRID_API_KEY_FILE must contain a 32 to 512 character SG. API key.",
    );
  }
  const sendGridApiBaseUrl = env.SENDGRID_API_BASE_URL
    ? secureServiceEndpoint(
        env.SENDGRID_API_BASE_URL,
        "SENDGRID_API_BASE_URL",
      )
    : "https://api.sendgrid.com";
  const sendGridApiUrl = new URL(sendGridApiBaseUrl);
  const approvedSendGridOrigin =
    sendGridApiUrl.protocol === "https:" &&
    sendGridApiUrl.port === "" &&
    (sendGridApiUrl.hostname === "api.sendgrid.com" ||
      sendGridApiUrl.hostname === "api.eu.sendgrid.com");
  const loopbackSendGridOrigin =
    sendGridApiUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(
      sendGridApiUrl.hostname,
    );
  if (
    mode === "portable" &&
    usesSendGrid &&
    !approvedSendGridOrigin &&
    !loopbackSendGridOrigin
  ) {
    throw new ValidationError(
      "SENDGRID_API_BASE_URL must be the global or EU SendGrid API origin (loopback HTTP is allowed only for tests).",
    );
  }
  const sendGridEventWebhookPublicKey = publicMultilineSetting(
    env,
    "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
  );
  const sendGridEventWebhookKeyIsPem =
    sendGridEventWebhookPublicKey?.startsWith(
      "-----BEGIN PUBLIC KEY-----",
    ) === true &&
    sendGridEventWebhookPublicKey.endsWith(
      "-----END PUBLIC KEY-----",
    );
  const sendGridEventWebhookKeyIsBase64 =
    sendGridEventWebhookPublicKey !== undefined &&
    sendGridEventWebhookPublicKey.length >= 64 &&
    sendGridEventWebhookPublicKey.length <= 4_096 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(
      sendGridEventWebhookPublicKey,
    );
  if (
    mode === "portable" &&
    usesSendGrid &&
    sendGridEventWebhookPublicKey !== undefined &&
    ((!sendGridEventWebhookKeyIsPem &&
      !sendGridEventWebhookKeyIsBase64) ||
      sendGridEventWebhookPublicKey.length > MAX_SECRET_FILE_BYTES ||
      sendGridEventWebhookPublicKey.includes("\0"))
  ) {
    throw new ValidationError(
      "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY must contain the SendGrid verification key in base64 or PEM form.",
    );
  }
  const portableObjectStorage = env.HAYASEND_OBJECT_STORAGE ?? "disabled";
  if (
    mode === "portable" &&
    !["disabled", "s3", "gcs", "azure-blob", "vercel-blob"].includes(
      portableObjectStorage,
    )
  ) {
    throw new ValidationError(
      "HAYASEND_OBJECT_STORAGE must be disabled, s3, gcs, azure-blob, or vercel-blob in portable mode.",
    );
  }
  const objectStorageBucket = env.HAYASEND_OBJECT_STORAGE_BUCKET;
  if (
    mode === "portable" &&
    !["disabled", "vercel-blob"].includes(portableObjectStorage) &&
    !objectStorageBucket
  ) {
    throw new ValidationError(
      "HAYASEND_OBJECT_STORAGE_BUCKET is required when portable object storage is enabled.",
    );
  }
  if (
    mode === "portable" &&
    portableObjectStorage === "disabled" &&
    objectStorageBucket
  ) {
    throw new ValidationError(
      "HAYASEND_OBJECT_STORAGE_BUCKET requires an enabled HAYASEND_OBJECT_STORAGE provider.",
    );
  }
  if (
    mode === "portable" &&
    portableObjectStorage === "vercel-blob" &&
    objectStorageBucket
  ) {
    throw new ValidationError(
      "HAYASEND_OBJECT_STORAGE_BUCKET is not used by Vercel Blob.",
    );
  }
  const portableQueueWakeup =
    env.HAYASEND_QUEUE_WAKEUP ?? "disabled";
  if (
    mode === "portable" &&
    !["disabled", "gcp-pubsub"].includes(portableQueueWakeup)
  ) {
    throw new ValidationError(
      "HAYASEND_QUEUE_WAKEUP must be disabled or gcp-pubsub in portable mode.",
    );
  }
  const gcpPubSubTopic = env.HAYASEND_GCP_PUBSUB_TOPIC;
  const gcpPubSubSubscription =
    env.HAYASEND_GCP_PUBSUB_SUBSCRIPTION;
  const validPubSubTopic =
    gcpPubSubTopic === undefined ||
    /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(
      gcpPubSubTopic,
    );
  const validPubSubSubscription =
    gcpPubSubSubscription === undefined ||
    /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(
      gcpPubSubSubscription,
    );
  if (
    mode === "portable" &&
    (!validPubSubTopic || !validPubSubSubscription)
  ) {
    throw new ValidationError(
      "Pub/Sub wake-up settings must use fully qualified Google Cloud resource names.",
    );
  }
  if (
    mode === "portable" &&
    portableQueueWakeup === "disabled" &&
    (gcpPubSubTopic || gcpPubSubSubscription)
  ) {
    throw new ValidationError(
      "Pub/Sub resource settings require HAYASEND_QUEUE_WAKEUP=gcp-pubsub.",
    );
  }
  if (
    objectStorageBucket &&
    (objectStorageBucket.length < 3 ||
      objectStorageBucket.length > 222 ||
      !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(objectStorageBucket))
  ) {
    throw new ValidationError(
      "HAYASEND_OBJECT_STORAGE_BUCKET must be a safe provider bucket or container name.",
    );
  }
  if (
    mode === "portable" &&
    portableObjectStorage === "azure-blob" &&
    objectStorageBucket &&
    (objectStorageBucket.length > 63 ||
      objectStorageBucket.includes("--") ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
        objectStorageBucket,
      ))
  ) {
    throw new ValidationError(
      "Azure Blob container names must be 3 to 63 lowercase letters, numbers, or single hyphens.",
    );
  }
  const s3Endpoint = env.HAYASEND_S3_ENDPOINT
    ? secureServiceEndpoint(
        env.HAYASEND_S3_ENDPOINT,
        "HAYASEND_S3_ENDPOINT",
      )
    : undefined;
  const azureStorageAccount = env.AZURE_STORAGE_ACCOUNT_NAME;
  if (
    mode === "portable" &&
    portableObjectStorage === "azure-blob" &&
    (!azureStorageAccount ||
      !/^[a-z0-9]{3,24}$/.test(azureStorageAccount))
  ) {
    throw new ValidationError(
      "AZURE_STORAGE_ACCOUNT_NAME is required for Azure Blob storage and must contain 3 to 24 lowercase letters or numbers.",
    );
  }
  const azureBlobEndpoint = env.HAYASEND_AZURE_BLOB_ENDPOINT
    ? secureServiceEndpoint(
        env.HAYASEND_AZURE_BLOB_ENDPOINT,
        "HAYASEND_AZURE_BLOB_ENDPOINT",
      )
    : undefined;
  const vercelBlobToken = secretSetting(env, "BLOB_READ_WRITE_TOKEN");
  if (
    mode === "portable" &&
    portableObjectStorage === "vercel-blob" &&
    (!vercelBlobToken ||
      vercelBlobToken.length < 32 ||
      vercelBlobToken.length > 4_096)
  ) {
    throw new ValidationError(
      "BLOB_READ_WRITE_TOKEN must contain 32 to 4096 characters for Vercel Blob storage.",
    );
  }
  if (
    mode === "portable" &&
    portableTransport === "console" &&
    env.NODE_ENV === "production" &&
    env.HAYASEND_CONSOLE_PROOF_CONFIRM !==
      CONSOLE_PROOF_CONFIRMATION
  ) {
    throw new ValidationError(
      `Production portable console mode is non-sending and requires HAYASEND_CONSOLE_PROOF_CONFIRM=${CONSOLE_PROOF_CONFIRMATION}.`,
    );
  }
  const host =
    env.HAYASEND_HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  if (
    host.length < 1 ||
    host.length > 253 ||
    /[\s/\\]/.test(host)
  ) {
    throw new ValidationError(
      "HAYASEND_HOST must be a valid host name or IP address.",
    );
  }
  const port = Number(env.HAYASEND_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError(
      "HAYASEND_PORT must be an integer between 1 and 65535.",
    );
  }
  const inboundRetentionDays = Number(
    env.HAYASEND_INBOUND_RETENTION_DAYS ?? 7,
  );
  if (
    !Number.isInteger(inboundRetentionDays) ||
    inboundRetentionDays < 1 ||
    inboundRetentionDays > 30
  ) {
    throw new ValidationError(
      "HAYASEND_INBOUND_RETENTION_DAYS must be an integer between 1 and 30.",
    );
  }
  const inboundMaxMessageBytes = Number(
    env.HAYASEND_INBOUND_MAX_MESSAGE_BYTES ?? 25 * 1024 * 1024,
  );
  if (
    !Number.isInteger(inboundMaxMessageBytes) ||
    inboundMaxMessageBytes < 1 ||
    inboundMaxMessageBytes > 40 * 1024 * 1024
  ) {
    throw new ValidationError(
      "HAYASEND_INBOUND_MAX_MESSAGE_BYTES must be an integer between 1 and 41943040.",
    );
  }
  const inboundRawPrefix =
    env.HAYASEND_INBOUND_RAW_PREFIX ?? "inbound/raw/";
  if (
    inboundRawPrefix.length < 1 ||
    inboundRawPrefix.length > 62 ||
    inboundRawPrefix.includes("..") ||
    /[^a-zA-Z0-9!_.*'()/-]/.test(inboundRawPrefix)
  ) {
    throw new ValidationError(
      "HAYASEND_INBOUND_RAW_PREFIX must be a safe S3 prefix of at most 62 characters.",
    );
  }
  const webhookDeliveryRetentionDays = Number(
    env.HAYASEND_WEBHOOK_DELIVERY_RETENTION_DAYS ?? 7,
  );
  if (
    !Number.isInteger(webhookDeliveryRetentionDays) ||
    webhookDeliveryRetentionDays < 1 ||
    webhookDeliveryRetentionDays > 30
  ) {
    throw new ValidationError(
      "HAYASEND_WEBHOOK_DELIVERY_RETENTION_DAYS must be an integer between 1 and 30.",
    );
  }
  const templateHistoryRetentionDays = Number(
    env.HAYASEND_TEMPLATE_HISTORY_RETENTION_DAYS ?? 90,
  );
  if (
    !Number.isInteger(templateHistoryRetentionDays) ||
    templateHistoryRetentionDays < 1 ||
    templateHistoryRetentionDays > 365
  ) {
    throw new ValidationError(
      "HAYASEND_TEMPLATE_HISTORY_RETENTION_DAYS must be an integer between 1 and 365.",
    );
  }
  const templateHistoryLimit = Number(
    env.HAYASEND_TEMPLATE_HISTORY_LIMIT ?? 50,
  );
  if (
    !Number.isInteger(templateHistoryLimit) ||
    templateHistoryLimit < 1 ||
    templateHistoryLimit > 50
  ) {
    throw new ValidationError(
      "HAYASEND_TEMPLATE_HISTORY_LIMIT must be an integer between 1 and 50.",
    );
  }

  const portableSettings =
    mode === "portable"
      ? {
          databaseUrl: databaseUrl as string,
          portableTransport: portableTransport as
            | "console"
            | "aws-ses"
            | "azure-communication-services"
            | "sendgrid",
          portableRuntimeProfile:
            portableCapabilityProfiles!.runtime,
          ...(portableCapabilityProfiles!.deployment
            ? {
                portableDeploymentProfile:
                  portableCapabilityProfiles!.deployment,
              }
            : {}),
          portableObjectStorage: portableObjectStorage as
            | "disabled"
            | "s3"
            | "gcs"
            | "azure-blob"
            | "vercel-blob",
          portableQueueWakeup: portableQueueWakeup as
            | "disabled"
            | "gcp-pubsub",
          ...(gcpPubSubTopic ? { gcpPubSubTopic } : {}),
          ...(gcpPubSubSubscription
            ? { gcpPubSubSubscription }
            : {}),
          ...(objectStorageBucket
            ? { objectStorageBucket }
            : {}),
          ...(s3Endpoint ? { s3Endpoint } : {}),
          s3ForcePathStyle: booleanSetting(
            env,
            "HAYASEND_S3_FORCE_PATH_STYLE",
            false,
          ),
          ...(env.GOOGLE_CLOUD_PROJECT
            ? { gcsProjectId: env.GOOGLE_CLOUD_PROJECT }
            : {}),
          ...(azureStorageAccount
            ? { azureStorageAccount }
            : {}),
          ...(azureBlobEndpoint
            ? { azureBlobEndpoint }
            : {}),
          ...(vercelBlobToken ? { vercelBlobToken } : {}),
          ...(azureCommunicationEmailEndpoint
            ? { azureCommunicationEmailEndpoint }
            : {}),
          ...(azureSubscriptionId ? { azureSubscriptionId } : {}),
          ...(azureResourceGroup ? { azureResourceGroup } : {}),
          ...(azureCommunicationServiceName
            ? { azureCommunicationServiceName }
            : {}),
          ...(azureEmailServiceName ? { azureEmailServiceName } : {}),
          ...(azureEmailDomainResourceName
            ? { azureEmailDomainResourceName }
            : {}),
          ...(azureEventGridSecret ? { azureEventGridSecret } : {}),
          ...(sendGridApiKey ? { sendGridApiKey } : {}),
          ...(usesSendGrid ? { sendGridApiBaseUrl } : {}),
          ...(sendGridEventWebhookPublicKey
            ? { sendGridEventWebhookPublicKey }
            : {}),
          postgresPoolMax: integerSetting(
            env,
            "HAYASEND_POSTGRES_POOL_MAX",
            10,
            1,
            100,
          ),
          postgresIdleTimeoutMs: integerSetting(
            env,
            "HAYASEND_POSTGRES_IDLE_TIMEOUT_MS",
            10_000,
            0,
            600_000,
          ),
          postgresConnectionTimeoutMs: integerSetting(
            env,
            "HAYASEND_POSTGRES_CONNECTION_TIMEOUT_MS",
            5_000,
            1,
            60_000,
          ),
          postgresMaxLifetimeSeconds: integerSetting(
            env,
            "HAYASEND_POSTGRES_MAX_LIFETIME_SECONDS",
            3_600,
            0,
            86_400,
          ),
          workerConcurrency: integerSetting(
            env,
            "HAYASEND_WORKER_CONCURRENCY",
            4,
            1,
            32,
          ),
          workerLeaseSeconds: integerSetting(
            env,
            "HAYASEND_WORKER_LEASE_SECONDS",
            60,
            5,
            900,
          ),
          workerPollIntervalMs: integerSetting(
            env,
            "HAYASEND_WORKER_POLL_INTERVAL_MS",
            500,
            50,
            60_000,
          ),
          workerRetryDelaySeconds: integerSetting(
            env,
            "HAYASEND_WORKER_RETRY_DELAY_SECONDS",
            30,
            0,
            3_600,
          ),
          workerOutboxIntervalMs: integerSetting(
            env,
            "HAYASEND_WORKER_OUTBOX_INTERVAL_MS",
            1_000,
            100,
            60_000,
          ),
          jobMaxAttempts: integerSetting(
            env,
            "HAYASEND_JOB_MAX_ATTEMPTS",
            10,
            1,
            100,
          ),
          jobRetentionDays: integerSetting(
            env,
            "HAYASEND_JOB_RETENTION_DAYS",
            7,
            1,
            30,
          ),
        }
      : {};

  return {
    mode,
    host,
    port,
    region:
      env.HAYASEND_REGION ??
      env.AWS_REGION ??
      env.AZURE_LOCATION ??
      "ap-northeast-1",
    inboundRawPrefix,
    inboundRetentionDays,
    inboundMaxMessageBytes,
    webhookDeliveryRetentionDays,
    templateHistoryRetentionDays,
    templateHistoryLimit,
    ...((mode === "local" || mode === "portable") && apiKey
      ? { apiKey }
      : {}),
    ...portableSettings,
    ...(apiKeySecretArn ? { apiKeySecretArn } : {}),
    ...(consoleAuthOrigin ? { consoleAuthOrigin } : {}),
    ...(consoleAuthGoogleClientId ? { consoleAuthGoogleClientId } : {}),
    ...(consoleAuthAllowedEmails ? { consoleAuthAllowedEmails } : {}),
    ...(consoleAuthCredentials ? { consoleAuthCredentials } : {}),
    ...(consoleAuthSecretArn ? { consoleAuthSecretArn } : {}),
    ...(env.HAYASEND_TABLE_NAME
      ? { tableName: env.HAYASEND_TABLE_NAME }
      : {}),
    ...(env.HAYASEND_QUEUE_URL
      ? { queueUrl: env.HAYASEND_QUEUE_URL }
      : {}),
    ...(env.HAYASEND_QUEUE_ARN
      ? { queueArn: env.HAYASEND_QUEUE_ARN }
      : {}),
    ...(env.HAYASEND_DLQ_URL
      ? { deliveryDeadLetterQueueUrl: env.HAYASEND_DLQ_URL }
      : {}),
    ...(env.HAYASEND_SCHEDULER_DLQ_URL
      ? {
          schedulerDeadLetterQueueUrl:
            env.HAYASEND_SCHEDULER_DLQ_URL,
        }
      : {}),
    ...(env.HAYASEND_INBOUND_DLQ_URL
      ? { inboundDeadLetterQueueUrl: env.HAYASEND_INBOUND_DLQ_URL }
      : {}),
    ...(env.HAYASEND_PAYLOAD_BUCKET
      ? { payloadBucket: env.HAYASEND_PAYLOAD_BUCKET }
      : {}),
    ...(env.HAYASEND_CONFIGURATION_SET
      ? { configurationSet: env.HAYASEND_CONFIGURATION_SET }
      : {}),
    ...(env.HAYASEND_SCHEDULER_GROUP_NAME
      ? { schedulerGroupName: env.HAYASEND_SCHEDULER_GROUP_NAME }
      : {}),
    ...(env.HAYASEND_SCHEDULER_ROLE_ARN
      ? { schedulerRoleArn: env.HAYASEND_SCHEDULER_ROLE_ARN }
      : {}),
    ...(env.HAYASEND_SCHEDULER_DLQ_ARN
      ? {
          schedulerDeadLetterQueueArn:
            env.HAYASEND_SCHEDULER_DLQ_ARN,
        }
      : {}),
    ...(env.HAYASEND_INBOUND_BUCKET
      ? { inboundBucket: env.HAYASEND_INBOUND_BUCKET }
      : {}),
  };
}

export function assertApiServerConfig(config: Config): void {
  if (
    config.mode === "portable" &&
    config.portableQueueWakeup === "gcp-pubsub" &&
    (!config.gcpPubSubTopic || config.gcpPubSubSubscription)
  ) {
    throw new ValidationError(
      "The API process requires only HAYASEND_GCP_PUBSUB_TOPIC when Pub/Sub wake-up is enabled.",
    );
  }
  if (
    config.mode === "portable" &&
    config.portableTransport === "azure-communication-services" &&
    !config.azureEventGridSecret
  ) {
    throw new ValidationError(
      "The Azure Communication Services API process requires HAYASEND_AZURE_EVENT_GRID_SECRET or HAYASEND_AZURE_EVENT_GRID_SECRET_FILE.",
    );
  }
  if (
    config.mode === "portable" &&
    config.portableTransport === "sendgrid" &&
    !config.sendGridEventWebhookPublicKey
  ) {
    throw new ValidationError(
      "The SendGrid API process requires SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY or SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY_FILE.",
    );
  }
}

export function assertPortableWorkerConfig(config: Config): void {
  if (
    config.mode === "portable" &&
    config.portableQueueWakeup === "gcp-pubsub" &&
    (!config.gcpPubSubSubscription || config.gcpPubSubTopic)
  ) {
    throw new ValidationError(
      "The worker process requires only HAYASEND_GCP_PUBSUB_SUBSCRIPTION when Pub/Sub wake-up is enabled.",
    );
  }
}
