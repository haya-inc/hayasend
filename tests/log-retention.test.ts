import { describe, expect, it, vi } from "vitest";
import {
  applyLegacyLogRetention,
  deleteProviderLogGroup,
  parseLogRetentionProperties,
  sendCloudFormationResponse,
  type CustomResourceResponse,
  type LogRetentionClient,
} from "../src/aws/log-retention.js";

function client(
  states: Record<string, { exists: boolean; retentionInDays?: number }>,
) {
  const put = vi.fn<LogRetentionClient["put"]>(async () => undefined);
  const remove = vi.fn<LogRetentionClient["delete"]>(async () => undefined);
  const describe = vi.fn<LogRetentionClient["describe"]>(
    async (logGroupName) => states[logGroupName] ?? { exists: false },
  );
  return {
    implementation: {
      describe,
      put,
      delete: remove,
    } satisfies LogRetentionClient,
    describe,
    put,
    remove,
  };
}

describe("legacy Lambda log retention", () => {
  it("accepts only exact Lambda groups and CloudWatch retention values", () => {
    expect(
      parseLogRetentionProperties({
        RetentionInDays: "30",
        LogGroupNames: ["/aws/lambda/hayasend-api"],
      }),
    ).toEqual({
      retentionInDays: 30,
      logGroupNames: ["/aws/lambda/hayasend-api"],
    });
    expect(() =>
      parseLogRetentionProperties({
        RetentionInDays: "2",
        LogGroupNames: ["/aws/lambda/hayasend-api"],
      }),
    ).toThrow("not supported");
    expect(() =>
      parseLogRetentionProperties({
        RetentionInDays: "30",
        LogGroupNames: ["/hayasend/stack/api"],
      }),
    ).toThrow("Lambda log groups");
    expect(() =>
      parseLogRetentionProperties({
        RetentionInDays: "30",
        LogGroupNames: ["/aws/lambda/api", "/aws/lambda/api"],
      }),
    ).toThrow("unique");
    expect(
      parseLogRetentionProperties({
        RetentionInDays: 30,
        LogGroupNames: [
          "/aws/lambda/api",
          "/aws/lambda/worker",
          "/aws/lambda/dispatcher",
          "/aws/lambda/events",
          "/aws/lambda/inbound",
        ],
      }).logGroupNames,
    ).toHaveLength(5);
  });

  it("updates existing groups, skips missing groups, and leaves matches alone", async () => {
    const logs = client({
      "/aws/lambda/api": { exists: true },
      "/aws/lambda/worker": { exists: true, retentionInDays: 7 },
      "/aws/lambda/events": { exists: false },
    });

    await expect(
      applyLegacyLogRetention(
        ["/aws/lambda/api", "/aws/lambda/worker", "/aws/lambda/events"],
        7,
        logs.implementation,
      ),
    ).resolves.toEqual({ unchanged: 1, updated: 1, missing: 1 });
    expect(logs.put).toHaveBeenCalledTimes(1);
    expect(logs.put).toHaveBeenCalledWith("/aws/lambda/api", 7);
    expect(logs.remove).not.toHaveBeenCalled();
  });

  it("restores prior finite and infinite policies after a partial failure", async () => {
    const logs = client({
      "/aws/lambda/api": { exists: true },
      "/aws/lambda/worker": { exists: true, retentionInDays: 14 },
      "/aws/lambda/events": { exists: true },
    });
    logs.put.mockImplementation(async (name, days) => {
      if (name === "/aws/lambda/events" && days === 30) {
        throw new Error("apply failed");
      }
    });

    await expect(
      applyLegacyLogRetention(
        ["/aws/lambda/api", "/aws/lambda/worker", "/aws/lambda/events"],
        30,
        logs.implementation,
      ),
    ).rejects.toThrow("apply failed");
    expect(logs.remove).toHaveBeenCalledWith("/aws/lambda/api");
    expect(logs.put).toHaveBeenCalledWith("/aws/lambda/worker", 14);
    expect(logs.put.mock.calls.slice(-1)[0]).toEqual([
      "/aws/lambda/worker",
      14,
    ]);
  });

  it("retries only transient metadata and policy failures", async () => {
    const logs = client({
      "/aws/lambda/api": { exists: true },
    });
    const transient = Object.assign(new Error("busy"), {
      name: "OperationAbortedException",
    });
    logs.describe
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ exists: true });
    const sleep = vi.fn(async () => undefined);

    await expect(
      applyLegacyLogRetention(
        ["/aws/lambda/api"],
        30,
        logs.implementation,
        sleep,
      ),
    ).resolves.toEqual({ unchanged: 0, updated: 1, missing: 0 });
    expect(sleep).toHaveBeenCalledWith(100);
    expect(logs.describe).toHaveBeenCalledTimes(2);
  });

  it("deletes only the exact provider group for the deleting stack", async () => {
    const deleteGroup = vi.fn(async () => undefined);
    const stackId =
      "arn:aws:cloudformation:ap-northeast-1:123456789012:" +
      "stack/hayasend-production/12345678-abcd-1234-abcd-123456789012";

    await expect(
      deleteProviderLogGroup(
        stackId,
        "/hayasend/hayasend-production/log-retention",
        { deleteGroup },
      ),
    ).resolves.toBeUndefined();
    expect(deleteGroup).toHaveBeenCalledWith(
      "/hayasend/hayasend-production/log-retention",
    );

    for (const logGroupName of [
      undefined,
      "/hayasend/another-stack/log-retention",
      "/aws/lambda/hayasend-production",
    ]) {
      await expect(
        deleteProviderLogGroup(stackId, logGroupName, { deleteGroup }),
      ).rejects.toThrow("does not match");
    }
    expect(deleteGroup).toHaveBeenCalledTimes(1);
  });

  it("accepts an already-absent provider group and retries transient deletion", async () => {
    const transient = Object.assign(new Error("busy"), {
      name: "OperationAbortedException",
    });
    const absent = Object.assign(new Error("gone"), {
      name: "ResourceNotFoundException",
    });
    const deleteGroup = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(absent);
    const sleep = vi.fn(async () => undefined);

    await expect(
      deleteProviderLogGroup(
        "arn:aws:cloudformation:us-east-1:123456789012:" +
          "stack/hayasend/12345678-abcd-1234-abcd-123456789012",
        "/hayasend/hayasend/log-retention",
        { deleteGroup },
        sleep,
      ),
    ).resolves.toBeUndefined();
    expect(deleteGroup).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("sends bounded responses only to the exact presigned CloudFormation bucket", async () => {
    const stackId =
      "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/hayasend/id";
    const responseUrl =
      "https://cloudformation-custom-resource-response-apnortheast1." +
      "s3.ap-northeast-1.amazonaws.com/response?" +
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
      "X-Amz-Credential=test&" +
      `X-Amz-Signature=${"a".repeat(64)}`;
    const body: CustomResourceResponse = {
      Status: "SUCCESS",
      Reason: "Configured.",
      PhysicalResourceId: "retention",
      StackId: stackId,
      RequestId: "request",
      LogicalResourceId: "LegacyFunctionLogRetention",
      NoEcho: true,
      Data: { unchanged: 1, updated: 2, missing: 1 },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      sendCloudFormationResponse(responseUrl, stackId, body, request, sleep),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      redirect: "error",
    });
    expect(sleep).toHaveBeenCalledWith(200);

    for (const unsafeUrl of [
      responseUrl.replace("https:", "http:"),
      responseUrl.replace(
        "s3.ap-northeast-1.amazonaws.com",
        "s3.ap-northeast-1.amazonaws.com.attacker.example",
      ),
      responseUrl.replace("apnortheast1.s3", "useast1.s3"),
      responseUrl.replace("apnortheast1", "ap-northeast-1"),
      responseUrl.replace(/&X-Amz-Signature=[a-f0-9]+/, ""),
    ]) {
      await expect(
        sendCloudFormationResponse(unsafeUrl, stackId, body, request, sleep),
      ).rejects.toThrow(/response URL|presigned/);
    }
    expect(request).toHaveBeenCalledTimes(2);

    await expect(
      sendCloudFormationResponse(
        responseUrl,
        stackId,
        { ...body, Reason: "x".repeat(4097) },
        request,
        sleep,
      ),
    ).rejects.toThrow("exceeds 4096 bytes");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected presigned response", async () => {
    const stackId =
      "arn:aws-cn:cloudformation:cn-north-1:123456789012:stack/hayasend/id";
    const responseUrl =
      "https://cloudformation-custom-resource-response-cnnorth1." +
      "s3.cn-north-1.amazonaws.com.cn/response?" +
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
      "X-Amz-Credential=test&" +
      `X-Amz-Signature=${"b".repeat(64)}`;
    const request = vi.fn(async () => new Response(null, { status: 403 }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      sendCloudFormationResponse(
        responseUrl,
        stackId,
        {
          Status: "FAILED",
          Reason: "Rejected.",
          PhysicalResourceId: "retention",
          StackId: stackId,
          RequestId: "request",
          LogicalResourceId: "LegacyFunctionLogRetention",
        },
        request,
        sleep,
      ),
    ).rejects.toThrow("HTTP 403");
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
