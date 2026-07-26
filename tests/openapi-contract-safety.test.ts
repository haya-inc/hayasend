import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeContractBaseUrl } from "../scripts/openapi-contract-safety.mjs";

describe("OpenAPI contract-test network safety", () => {
  it("normalizes explicit loopback origins", () => {
    expect(
      normalizeContractBaseUrl("http://127.0.0.1:8787/"),
    ).toBe("http://127.0.0.1:8787");
    expect(normalizeContractBaseUrl("https://localhost")).toBe(
      "https://localhost",
    );
    expect(normalizeContractBaseUrl("http://[::1]:8787")).toBe(
      "http://[::1]:8787",
    );
    expect(normalizeContractBaseUrl("http://127.255.1.2:8787")).toBe(
      "http://127.255.1.2:8787",
    );
  });

  it("rejects every non-loopback or ambiguous target", () => {
    for (const endpoint of [
      "",
      "api.example.com",
      "https://api.resend.com",
      "http://10.0.0.1:8787",
      "http://localhost.example:8787",
      "http://user:secret@localhost:8787",
      "http://localhost:8787/api",
      "http://localhost:8787?target=other",
      "http://localhost:8787#fragment",
      "ftp://localhost:8787",
    ]) {
      expect(
        () => normalizeContractBaseUrl(endpoint),
        endpoint,
      ).toThrow("loopback");
    }
  });

  it("documents the shared error response for every operation", () => {
    const contract = readFileSync(
      new URL("../openapi.yaml", import.meta.url),
      "utf8",
    );
    const operations = contract.match(/^      operationId: /gm) ?? [];
    const defaultErrors =
      contract.match(
        /^        default:\n          \$ref: "#\/components\/responses\/Error"$/gm,
      ) ?? [];

    expect(operations).toHaveLength(46);
    expect(defaultErrors).toHaveLength(operations.length);
  });
});
