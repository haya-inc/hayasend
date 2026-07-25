import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses a development bootstrap key in local mode", () => {
    expect(loadConfig({})).toMatchObject({
      mode: "local",
      apiKey: "re_hayasend_dev",
      port: 8787,
    });
  });

  it("requires a Secrets Manager ARN in AWS mode", () => {
    expect(() => loadConfig({ HAYASEND_MODE: "aws" })).toThrow(
      "HAYASEND_API_KEY_SECRET_ARN is required in AWS mode.",
    );
  });

  it("rejects plaintext bootstrap keys in AWS mode", () => {
    expect(() =>
      loadConfig({
        HAYASEND_MODE: "aws",
        HAYASEND_API_KEY: "not-allowed-in-a-lambda-environment",
        HAYASEND_API_KEY_SECRET_ARN:
          "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test",
      }),
    ).toThrow(
      "HAYASEND_API_KEY is not supported in AWS mode; use Secrets Manager.",
    );
  });

  it("accepts a Secrets Manager ARN without exposing a plaintext key", () => {
    const config = loadConfig({
      HAYASEND_MODE: "aws",
      HAYASEND_API_KEY_SECRET_ARN:
        "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test",
    });

    expect(config.apiKeySecretArn).toContain(":secretsmanager:");
    expect(config.apiKey).toBeUndefined();
  });
});
