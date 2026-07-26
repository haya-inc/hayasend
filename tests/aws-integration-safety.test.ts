import { describe, expect, it } from "vitest";
import { normalizeApiGatewayBaseUrl } from "../scripts/aws-integration-safety.mjs";

describe("AWS integration network safety", () => {
  it("accepts only the expected regional API Gateway endpoint", () => {
    expect(
      normalizeApiGatewayBaseUrl(
        "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com/",
        "abc123def4",
        "ap-northeast-1",
      ),
    ).toBe(
      "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com",
    );

    for (const endpoint of [
      "http://abc123def4.execute-api.ap-northeast-1.amazonaws.com",
      "https://other12345.execute-api.ap-northeast-1.amazonaws.com",
      "https://abc123def4.execute-api.us-east-1.amazonaws.com",
      "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com:444",
      "https://user:secret@abc123def4.execute-api.ap-northeast-1.amazonaws.com",
      "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com/stage",
      "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com?target=other",
      "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com#fragment",
      "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com.attacker.example",
    ]) {
      expect(() =>
        normalizeApiGatewayBaseUrl(
          endpoint,
          "abc123def4",
          "ap-northeast-1",
        ),
      ).toThrow("expected dedicated API Gateway endpoint");
    }
  });

  it("rejects malformed expected deployment identifiers", () => {
    expect(() =>
      normalizeApiGatewayBaseUrl(
        "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com",
        "abc123def4.example",
        "ap-northeast-1",
      ),
    ).toThrow("identifier or Region is invalid");
    expect(() =>
      normalizeApiGatewayBaseUrl(
        "https://abc123def4.execute-api.ap-northeast-1.amazonaws.com",
        "abc123def4",
        "ap-northeast-1.amazonaws.com",
      ),
    ).toThrow("identifier or Region is invalid");
  });
});
