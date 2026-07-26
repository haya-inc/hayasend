#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PRICING_LAST_VERIFIED = "2026-07-26";

const KIB_PER_GIB = 1024 * 1024;
const MIB_PER_GIB = 1024;
const BYTES_PER_DECIMAL_GB = 1_000_000_000;

export const REGION_RATES = {
  "us-east-1": {
    apiHttpRequest: 1 / 1_000_000,
    lambdaRequest: 0.2 / 1_000_000,
    lambdaArmGbSecond: 0.0000133334,
    dynamodbWriteRequestUnit: 0.625 / 1_000_000,
    dynamodbReadRequestUnit: 0.125 / 1_000_000,
    dynamodbStorageGbMonth: 0.25,
    dynamodbPitrGbMonth: 0.2,
    sqsStandardRequest: 0.4 / 1_000_000,
    schedulerInvocation: 1 / 1_000_000,
    s3StandardStorageGbMonth: 0.023,
    s3PutRequest: 0.005 / 1_000,
    s3GetRequest: 0.004 / 10_000,
    snsStandardRequest: 0.5 / 1_000_000,
    cloudwatchLogIngestGb: 0.5,
    cloudwatchLogStorageGbMonth: 0.03,
    cloudwatchStandardAlarmMetric: 0.1,
    cloudwatchDashboard: 3,
  },
  "ap-northeast-1": {
    apiHttpRequest: 1.29 / 1_000_000,
    lambdaRequest: 0.2 / 1_000_000,
    lambdaArmGbSecond: 0.0000133334,
    dynamodbWriteRequestUnit: 0.715 / 1_000_000,
    dynamodbReadRequestUnit: 0.1425 / 1_000_000,
    dynamodbStorageGbMonth: 0.285,
    dynamodbPitrGbMonth: 0.228,
    sqsStandardRequest: 0.4 / 1_000_000,
    schedulerInvocation: 1.25 / 1_000_000,
    s3StandardStorageGbMonth: 0.025,
    s3PutRequest: 0.0047 / 1_000,
    s3GetRequest: 0.0037 / 10_000,
    snsStandardRequest: 0.5 / 1_000_000,
    cloudwatchLogIngestGb: 0.76,
    cloudwatchLogStorageGbMonth: 0.033,
    cloudwatchStandardAlarmMetric: 0.1,
    cloudwatchDashboard: 3,
  },
};

export const WORKLOAD_PROFILES = {
  light: {
    messages: 10_000,
    webhookCoverage: 0.25,
    scheduledFraction: 0.01,
  },
  representative: {
    messages: 1_000_000,
    webhookCoverage: 1,
    scheduledFraction: 0.05,
  },
};

const DEFAULT_ASSUMPTIONS = {
  eventsPerMessage: 2,
  messageKiB: 32,
  retainedMonths: 12,
  logKiBPerInvocation: 2,
  payloadRetentionDays: 45,
  webhookRetentionDays: 7,
  emailMetadataKiB: 2,
  webhookMetadataKiB: 2,
  idempotencyMetadataKiB: 1,
  lambdaMemoryGiB: 0.25,
  lambdaApiSeconds: 0.1,
  lambdaSendWorkerSeconds: 0.3,
  lambdaSesEventSeconds: 0.1,
  lambdaWebhookSeconds: 0.2,
  dynamodbBaseWriteUnitsPerMessage: 6,
  dynamodbBaseReadUnitsPerMessage: 5,
  dynamodbWriteUnitsPerProviderEvent: 1,
  dynamodbReadUnitsPerProviderEvent: 1,
  dynamodbWriteUnitsPerWebhook: 3,
  dynamodbReadUnitsPerWebhook: 3,
  sqsRequestsPerJob: 3,
  standardAlarmMetrics: 7,
  dashboards: 1,
  attachmentShare: 0,
  attachmentMiB: 1,
};

const FREE_ALLOWANCES = {
  lambdaRequests: 1_000_000,
  lambdaGbSeconds: 400_000,
  dynamodbStorageGiB: 25,
  sqsRequests: 1_000_000,
  schedulerInvocations: 14_000_000,
  snsRequests: 1_000_000,
  cloudwatchLogIngestGiB: 5,
  cloudwatchLogStorageGiB: 5,
  cloudwatchAlarmMetrics: 10,
  cloudwatchDashboards: 3,
};

function round(value, digits = 6) {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function lineItem(quantity, rate, freeAllowance = 0) {
  const billableQuantity = Math.max(0, quantity - freeAllowance);
  return {
    quantity: round(quantity),
    unit_rate_usd: rate,
    free_allowance: round(freeAllowance),
    billable_quantity: round(billableQuantity),
    monthly_usd: round(billableQuantity * rate),
  };
}

function category(components) {
  return {
    components,
    monthly_usd: round(
      Object.values(components).reduce(
        (total, component) => total + component.monthly_usd,
        0,
      ),
    ),
  };
}

function requireFinite(name, value, minimum, maximum = Infinity) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function estimateAwsCosts({
  region = "us-east-1",
  profile = "representative",
  freeTier = "none",
  sesPricing = "a-la-carte",
  overrides = {},
} = {}) {
  const rates = REGION_RATES[region];
  if (!rates) {
    throw new Error(
      `region must be one of ${Object.keys(REGION_RATES).join(", ")}.`,
    );
  }
  const workload = WORKLOAD_PROFILES[profile];
  if (!workload) {
    throw new Error(
      `profile must be one of ${Object.keys(WORKLOAD_PROFILES).join(", ")}.`,
    );
  }
  if (!["none", "persistent"].includes(freeTier)) {
    throw new Error("freeTier must be none or persistent.");
  }
  if (!["a-la-carte", "essentials"].includes(sesPricing)) {
    throw new Error("sesPricing must be a-la-carte or essentials.");
  }

  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    ...workload,
    ...overrides,
  };
  requireFinite("messages", assumptions.messages, 1);
  if (!Number.isInteger(assumptions.messages)) {
    throw new Error("messages must be an integer.");
  }
  requireFinite("webhookCoverage", assumptions.webhookCoverage, 0, 1);
  requireFinite("scheduledFraction", assumptions.scheduledFraction, 0, 1);
  requireFinite("messageKiB", assumptions.messageKiB, 0);
  requireFinite("retainedMonths", assumptions.retainedMonths, 1);
  requireFinite(
    "logKiBPerInvocation",
    assumptions.logKiBPerInvocation,
    0,
  );
  requireFinite("attachmentShare", assumptions.attachmentShare, 0, 1);
  requireFinite("attachmentMiB", assumptions.attachmentMiB, 0);

  const useFreeTier = freeTier === "persistent";
  const free = (name) => (useFreeTier ? FREE_ALLOWANCES[name] : 0);
  const messages = assumptions.messages;
  const providerEvents = messages * assumptions.eventsPerMessage;
  const webhookDeliveries =
    providerEvents * assumptions.webhookCoverage;
  const attachmentObjects = messages * assumptions.attachmentShare;
  const attachmentStorageGiB =
    (attachmentObjects * assumptions.attachmentMiB) / MIB_PER_GIB;
  const sesAttachmentDataGb =
    (attachmentObjects * assumptions.attachmentMiB * 1024 * 1024) /
    BYTES_PER_DECIMAL_GB;

  const lambdaInvocations =
    messages * 2 + providerEvents + webhookDeliveries;
  const lambdaGbSeconds =
    assumptions.lambdaMemoryGiB *
    (messages * assumptions.lambdaApiSeconds +
      messages * assumptions.lambdaSendWorkerSeconds +
      providerEvents * assumptions.lambdaSesEventSeconds +
      webhookDeliveries * assumptions.lambdaWebhookSeconds);

  const dynamodbWriteUnits =
    messages * assumptions.dynamodbBaseWriteUnitsPerMessage +
    providerEvents * assumptions.dynamodbWriteUnitsPerProviderEvent +
    webhookDeliveries * assumptions.dynamodbWriteUnitsPerWebhook;
  const dynamodbReadUnits =
    messages * assumptions.dynamodbBaseReadUnitsPerMessage +
    providerEvents * assumptions.dynamodbReadUnitsPerProviderEvent +
    webhookDeliveries * assumptions.dynamodbReadUnitsPerWebhook;
  const durableEmailMetadataGiB =
    (messages *
      assumptions.emailMetadataKiB *
      assumptions.retainedMonths) /
    KIB_PER_GIB;
  const retainedWebhookMetadataGiB =
    (webhookDeliveries *
      assumptions.webhookMetadataKiB *
      (assumptions.webhookRetentionDays / 30)) /
    KIB_PER_GIB;
  const idempotencyMetadataGiB =
    (messages * assumptions.idempotencyMetadataKiB * (1 / 30)) /
    KIB_PER_GIB;
  const dynamodbStorageGiB =
    durableEmailMetadataGiB +
    retainedWebhookMetadataGiB +
    idempotencyMetadataGiB;

  const sqsRequests =
    (messages + webhookDeliveries) * assumptions.sqsRequestsPerJob;
  const schedulerInvocations = messages * assumptions.scheduledFraction;
  const payloadStorageGiB =
    ((messages * assumptions.messageKiB) / KIB_PER_GIB +
      attachmentStorageGiB) *
    (assumptions.payloadRetentionDays / 30);
  const s3ObjectRequests = messages + attachmentObjects;
  const snsRequests = providerEvents;
  const cloudwatchLogGiB =
    (lambdaInvocations * assumptions.logKiBPerInvocation) / KIB_PER_GIB;

  const costs = {
    api_gateway: category({
      http_api_requests: lineItem(
        messages,
        rates.apiHttpRequest,
      ),
    }),
    lambda: category({
      requests: lineItem(
        lambdaInvocations,
        rates.lambdaRequest,
        free("lambdaRequests"),
      ),
      arm_gib_seconds: lineItem(
        lambdaGbSeconds,
        rates.lambdaArmGbSecond,
        free("lambdaGbSeconds"),
      ),
    }),
    dynamodb: category({
      write_request_units: lineItem(
        dynamodbWriteUnits,
        rates.dynamodbWriteRequestUnit,
      ),
      read_request_units: lineItem(
        dynamodbReadUnits,
        rates.dynamodbReadRequestUnit,
      ),
      standard_storage_gib_month: lineItem(
        dynamodbStorageGiB,
        rates.dynamodbStorageGbMonth,
        free("dynamodbStorageGiB"),
      ),
      pitr_storage_gib_month: lineItem(
        dynamodbStorageGiB,
        rates.dynamodbPitrGbMonth,
      ),
    }),
    sqs: category({
      standard_requests: lineItem(
        sqsRequests,
        rates.sqsStandardRequest,
        free("sqsRequests"),
      ),
    }),
    eventbridge_scheduler: category({
      scheduled_invocations: lineItem(
        schedulerInvocations,
        rates.schedulerInvocation,
        free("schedulerInvocations"),
      ),
    }),
    s3: category({
      standard_storage_gib_month: lineItem(
        payloadStorageGiB,
        rates.s3StandardStorageGbMonth,
      ),
      put_requests: lineItem(
        s3ObjectRequests,
        rates.s3PutRequest,
      ),
      get_requests: lineItem(
        s3ObjectRequests,
        rates.s3GetRequest,
      ),
    }),
    sns: category({
      standard_requests: lineItem(
        snsRequests,
        rates.snsStandardRequest,
        free("snsRequests"),
      ),
    }),
    cloudwatch: category({
      log_ingestion_gib: lineItem(
        cloudwatchLogGiB,
        rates.cloudwatchLogIngestGb,
        free("cloudwatchLogIngestGiB"),
      ),
      log_storage_gib_month: lineItem(
        cloudwatchLogGiB,
        rates.cloudwatchLogStorageGbMonth,
        free("cloudwatchLogStorageGiB"),
      ),
      standard_alarm_metrics: lineItem(
        assumptions.standardAlarmMetrics,
        rates.cloudwatchStandardAlarmMetric,
        free("cloudwatchAlarmMetrics"),
      ),
      dashboards: lineItem(
        assumptions.dashboards,
        rates.cloudwatchDashboard,
        free("cloudwatchDashboards"),
      ),
    }),
  };
  const infrastructureTotal = round(
    Object.values(costs).reduce(
      (total, service) => total + service.monthly_usd,
      0,
    ),
  );
  const sesMessageRate =
    sesPricing === "essentials" ? 0.16 / 1_000 : 0.1 / 1_000;
  const sesMessages = messages * sesMessageRate;
  const sesAttachmentData = sesAttachmentDataGb * 0.12;
  const sesTotal = round(sesMessages + sesAttachmentData);

  return {
    schema_version: 1,
    pricing_last_verified: PRICING_LAST_VERIFIED,
    region,
    workload: profile,
    free_tier: freeTier,
    ses_pricing: sesPricing,
    assumptions: {
      ...assumptions,
      notes: {
        api: "One HTTP API request per accepted outbound message.",
        events:
          "Two SES notifications per message; successful webhook fan-out is controlled by webhookCoverage.",
        storage:
          "DynamoDB shows the retained-month checkpoint; S3 shows steady-state 45-day payload retention.",
        logs:
          "CloudWatch log retention is modeled at 30 days; generated Lambda log groups otherwise retain indefinitely.",
      },
    },
    quantities: {
      provider_events: round(providerEvents),
      webhook_deliveries: round(webhookDeliveries),
      lambda_invocations: round(lambdaInvocations),
      lambda_gib_seconds: round(lambdaGbSeconds),
      dynamodb_write_request_units: round(dynamodbWriteUnits),
      dynamodb_read_request_units: round(dynamodbReadUnits),
      dynamodb_storage_gib: round(dynamodbStorageGiB),
      sqs_requests: round(sqsRequests),
      scheduler_invocations: round(schedulerInvocations),
      s3_storage_gib: round(payloadStorageGiB),
      sns_requests: round(snsRequests),
      cloudwatch_log_gib: round(cloudwatchLogGiB),
      attachment_storage_gib: round(attachmentStorageGiB),
      ses_attachment_data_gb: round(sesAttachmentDataGb),
    },
    costs: {
      ...costs,
      infrastructure_total_usd: infrastructureTotal,
      ses: {
        message_charges_usd: round(sesMessages),
        attachment_data_usd: round(sesAttachmentData),
        monthly_usd: sesTotal,
      },
      estimated_total_usd: round(infrastructureTotal + sesTotal),
    },
  };
}

function parseCli(argv) {
  const values = {
    profile: "representative",
    region: "us-east-1",
    freeTier: "none",
    sesPricing: "a-la-carte",
    overrides: {},
  };
  const options = new Map([
    ["--profile", ["profile", String]],
    ["--region", ["region", String]],
    ["--free-tier", ["freeTier", String]],
    ["--ses", ["sesPricing", String]],
    ["--messages", ["messages", Number]],
    ["--webhook-coverage", ["webhookCoverage", Number]],
    ["--scheduled-fraction", ["scheduledFraction", Number]],
    ["--message-kib", ["messageKiB", Number]],
    ["--retained-months", ["retainedMonths", Number]],
    ["--log-kib-per-invocation", ["logKiBPerInvocation", Number]],
    ["--attachment-share", ["attachmentShare", Number]],
    ["--attachment-mib", ["attachmentMiB", Number]],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") {
      return { help: true };
    }
    const definition = options.get(option);
    if (!definition) {
      throw new Error(`Unknown option: ${option}`);
    }
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    index += 1;
    const [key, convert] = definition;
    const value = convert(raw);
    if (convert === Number && !Number.isFinite(value)) {
      throw new Error(`${option} requires a number.`);
    }
    if (["profile", "region", "freeTier", "sesPricing"].includes(key)) {
      values[key] = value;
    } else {
      values.overrides[key] = value;
    }
  }
  return values;
}

function help() {
  return `HayaSend AWS cost model

Usage:
  node scripts/aws-cost-model.mjs [options]

Options:
  --profile light|representative
  --region us-east-1|ap-northeast-1
  --free-tier none|persistent
  --ses a-la-carte|essentials
  --messages NUMBER
  --webhook-coverage 0..1
  --scheduled-fraction 0..1
  --message-kib NUMBER
  --retained-months NUMBER
  --log-kib-per-invocation NUMBER
  --attachment-share 0..1
  --attachment-mib NUMBER
`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(help());
    } else {
      process.stdout.write(
        `${JSON.stringify(estimateAwsCosts(options), null, 2)}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
