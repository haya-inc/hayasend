import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DeleteRetentionPolicyCommand,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudFormationCustomResourceEvent } from "aws-lambda";

export const CLOUDWATCH_LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
] as const;

interface LogGroupState {
  exists: boolean;
  retentionInDays?: number;
}

export interface LogRetentionClient {
  describe(logGroupName: string): Promise<LogGroupState>;
  put(logGroupName: string, retentionInDays: number): Promise<void>;
  delete(logGroupName: string): Promise<void>;
}

export interface LogRetentionResult {
  unchanged: number;
  updated: number;
  missing: number;
}

export interface ProviderLogGroupClient {
  deleteGroup(logGroupName: string): Promise<void>;
}

type Sleeper = (milliseconds: number) => Promise<void>;
type HttpRequest = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const retryableErrors = new Set([
  "OperationAbortedException",
  "ServiceUnavailableException",
  "ThrottlingException",
]);

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "";
}

async function retry<T>(
  operation: () => Promise<T>,
  sleep: Sleeper,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!retryableErrors.has(errorName(error)) || attempt === 2) {
        throw error;
      }
      await sleep(100 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function applyLegacyLogRetention(
  logGroupNames: string[],
  retentionInDays: number,
  client: LogRetentionClient,
  sleep: Sleeper = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<LogRetentionResult> {
  const changed: Array<{
    logGroupName: string;
    previousRetentionInDays?: number;
  }> = [];
  const result: LogRetentionResult = {
    unchanged: 0,
    updated: 0,
    missing: 0,
  };

  try {
    for (const logGroupName of logGroupNames) {
      const previous = await retry(() => client.describe(logGroupName), sleep);
      if (!previous.exists) {
        result.missing += 1;
        continue;
      }
      if (previous.retentionInDays === retentionInDays) {
        result.unchanged += 1;
        continue;
      }
      await retry(() => client.put(logGroupName, retentionInDays), sleep);
      changed.push({
        logGroupName,
        ...(previous.retentionInDays === undefined
          ? {}
          : { previousRetentionInDays: previous.retentionInDays }),
      });
      result.updated += 1;
    }
    return result;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const change of changed.reverse()) {
      try {
        if (change.previousRetentionInDays === undefined) {
          await retry(() => client.delete(change.logGroupName), sleep);
        } else {
          await retry(
            () =>
              client.put(
                change.logGroupName,
                change.previousRetentionInDays as number,
              ),
            sleep,
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Failed to apply log retention and fully restore prior policies.",
      );
    }
    throw error;
  }
}

export function parseLogRetentionProperties(
  properties: Record<string, unknown>,
) {
  const rawDays = properties.RetentionInDays;
  const retentionInDays =
    typeof rawDays === "number"
      ? rawDays
      : typeof rawDays === "string" && /^\d+$/.test(rawDays)
        ? Number(rawDays)
        : Number.NaN;
  if (
    !CLOUDWATCH_LOG_RETENTION_DAYS.includes(
      retentionInDays as (typeof CLOUDWATCH_LOG_RETENTION_DAYS)[number],
    )
  ) {
    throw new Error("RetentionInDays is not supported by CloudWatch Logs.");
  }

  const rawNames = properties.LogGroupNames;
  if (
    !Array.isArray(rawNames) ||
    rawNames.length < 1 ||
    rawNames.length > 5 ||
    rawNames.some(
      (name) =>
        typeof name !== "string" ||
        !/^\/aws\/lambda\/[A-Za-z0-9-_]{1,64}$/.test(name),
    )
  ) {
    throw new Error("LogGroupNames must contain 1-5 Lambda log groups.");
  }
  const logGroupNames = rawNames as string[];
  if (new Set(logGroupNames).size !== logGroupNames.length) {
    throw new Error("LogGroupNames must be unique.");
  }
  return { logGroupNames, retentionInDays };
}

function awsLogRetentionClient(): LogRetentionClient {
  const client = new CloudWatchLogsClient({});
  return {
    async describe(logGroupName) {
      const response = await client.send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: logGroupName,
          limit: 50,
        }),
      );
      const group = response.logGroups?.find(
        (candidate) => candidate.logGroupName === logGroupName,
      );
      return group
        ? {
            exists: true,
            ...(group.retentionInDays === undefined
              ? {}
              : { retentionInDays: group.retentionInDays }),
          }
        : { exists: false };
    },
    async put(logGroupName, retentionInDays) {
      await client.send(
        new PutRetentionPolicyCommand({ logGroupName, retentionInDays }),
      );
    },
    async delete(logGroupName) {
      await client.send(new DeleteRetentionPolicyCommand({ logGroupName }));
    },
  };
}

function providerLogGroupName(stackId: string) {
  const match = stackId.match(
    /^arn:(?:aws|aws-cn|aws-us-gov):cloudformation:[a-z0-9-]+:\d{12}:stack\/([A-Za-z][A-Za-z0-9-]{0,127})\/[A-Za-z0-9-]+$/,
  );
  if (!match?.[1]) {
    throw new Error("CloudFormation stack ARN is not supported.");
  }
  return `/hayasend/${match[1]}/log-retention`;
}

export async function deleteProviderLogGroup(
  stackId: string,
  actualLogGroupName: string | undefined,
  client: ProviderLogGroupClient,
  sleep: Sleeper = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const expectedLogGroupName = providerLogGroupName(stackId);
  if (actualLogGroupName !== expectedLogGroupName) {
    throw new Error(
      "Lambda provider log group does not match the CloudFormation stack.",
    );
  }
  try {
    await retry(() => client.deleteGroup(expectedLogGroupName), sleep);
  } catch (error) {
    if (errorName(error) !== "ResourceNotFoundException") {
      throw error;
    }
  }
}

function awsProviderLogGroupClient(): ProviderLogGroupClient {
  const client = new CloudWatchLogsClient({});
  return {
    async deleteGroup(logGroupName) {
      await client.send(new DeleteLogGroupCommand({ logGroupName }));
    },
  };
}

export interface CustomResourceResponse {
  Status: "SUCCESS" | "FAILED";
  Reason: string;
  PhysicalResourceId: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  NoEcho?: true;
  Data?: LogRetentionResult;
}

function safeReason(error: unknown) {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Unknown error";
  return message.replace(/[\r\n\t]/g, " ").slice(0, 512);
}

function cloudFormationResponseUrl(responseUrl: string, stackId: string) {
  const stackParts = stackId.split(":");
  const partition = stackParts[1];
  const region = stackParts[3];
  if (
    !["aws", "aws-cn", "aws-us-gov"].includes(partition ?? "") ||
    !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(region ?? "")
  ) {
    throw new Error("CloudFormation stack ARN is not supported.");
  }
  const urlSuffix =
    partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  const bucketRegion = (region ?? "").replaceAll("-", "");
  const bucket = `cloudformation-custom-resource-response-${bucketRegion}`;
  const allowedHosts = new Set([
    `${bucket}.s3.${urlSuffix}`,
    `${bucket}.s3.${region}.${urlSuffix}`,
    `${bucket}.s3-${region}.${urlSuffix}`,
  ]);
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new Error("CloudFormation response URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !allowedHosts.has(url.hostname)
  ) {
    throw new Error("CloudFormation response URL is not an allowed S3 URL.");
  }
  if (
    url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    !/^[a-f0-9]{64}$/i.test(url.searchParams.get("X-Amz-Signature") ?? "") ||
    !url.searchParams.has("X-Amz-Credential")
  ) {
    throw new Error("CloudFormation response URL is not presigned.");
  }
  return url;
}

export async function sendCloudFormationResponse(
  responseUrl: string,
  stackId: string,
  body: CustomResourceResponse,
  request: HttpRequest = fetch,
  sleep: Sleeper = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 4096) {
    throw new Error("CloudFormation response exceeds 4096 bytes.");
  }
  const url = cloudFormationResponseUrl(responseUrl, stackId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await request(url, {
        method: "PUT",
        headers: {
          "content-length": String(Buffer.byteLength(serialized)),
          "content-type": "",
        },
        body: serialized,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt < 2) {
        await sleep(200 * 2 ** attempt);
      }
      continue;
    }
    if (response.ok) {
      return;
    }
    const failure = new Error(
      `CloudFormation response failed with HTTP ${response.status}.`,
    );
    if (response.status < 500 && response.status !== 429) {
      throw failure;
    }
    if (attempt < 2) {
      await sleep(200 * 2 ** attempt);
    }
  }
  throw new Error(
    "Unable to deliver the CloudFormation response after bounded retries.",
  );
}

export async function handler(event: CloudFormationCustomResourceEvent) {
  const physicalResourceId =
    ("PhysicalResourceId" in event ? event.PhysicalResourceId : undefined) ??
    `${event.StackId}/${event.LogicalResourceId}/legacy-log-retention`;
  let status: CustomResourceResponse["Status"] = "SUCCESS";
  let reason = "Legacy Lambda log retention is configured.";
  let data: LogRetentionResult = { unchanged: 0, updated: 0, missing: 0 };

  try {
    if (event.RequestType !== "Delete") {
      const properties = parseLogRetentionProperties(
        event.ResourceProperties as Record<string, unknown>,
      );
      data = await applyLegacyLogRetention(
        properties.logGroupNames,
        properties.retentionInDays,
        awsLogRetentionClient(),
      );
    } else {
      await deleteProviderLogGroup(
        event.StackId,
        process.env.AWS_LAMBDA_LOG_GROUP_NAME,
        awsProviderLogGroupClient(),
      );
      reason =
        "Legacy Lambda log groups and their finite retention are deliberately preserved; the provider log group was removed.";
    }
  } catch (error) {
    status = "FAILED";
    reason = safeReason(error);
  }

  const response: CustomResourceResponse = {
    Status: status,
    Reason: reason,
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    ...(event.RequestType === "Delete"
      ? {}
      : {
          NoEcho: true as const,
          Data: data,
        }),
  };
  await sendCloudFormationResponse(event.ResponseURL, event.StackId, response);
}
