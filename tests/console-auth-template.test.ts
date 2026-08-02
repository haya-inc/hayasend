import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  new URL("../template.yaml", import.meta.url),
  "utf8",
);

const originPattern = template.match(
  /  ConsoleAuthOrigin:\n[\s\S]*?AllowedPattern: '([^']+)'/,
)?.[1];
const allowedEmailsPattern = template.match(
  /  ConsoleAuthAllowedEmails:\n[\s\S]*?AllowedPattern: '([^']+)'/,
)?.[1];

describe("console authentication CloudFormation parameters", () => {
  it("accepts canonical HTTPS origins with Java-compatible whitespace syntax", () => {
    expect(originPattern).toBe("^$|^https://[^/\\s]+$");

    const regex = /^$|^https:\/\/[^/\s]+$/;
    expect(regex.test("")).toBe(true);
    expect(
      regex.test(
        "https://co0dbk3i44.execute-api.ap-northeast-1.amazonaws.com",
      ),
    ).toBe(true);
    expect(regex.test("https://console.example.com:8443")).toBe(true);
    expect(regex.test("http://console.example.com")).toBe(false);
    expect(regex.test("https://console.example.com/path")).toBe(false);
    expect(regex.test("https://console.example.com value")).toBe(false);
  });

  it("accepts the normalized operator allowlist without POSIX classes", () => {
    expect(allowedEmailsPattern).toBe(
      "^$|^[^,\\s@]+@[^,\\s@]+(?:,[^,\\s@]+@[^,\\s@]+){0,49}$",
    );

    const regex = /^$|^[^,\s@]+@[^,\s@]+(?:,[^,\s@]+@[^,\s@]+){0,49}$/;
    expect(regex.test("")).toBe(true);
    expect(regex.test("yusuke@haya.company")).toBe(true);
    expect(regex.test("one@haya.company,two@haya.company")).toBe(true);
    expect(regex.test("one@haya.company, two@haya.company")).toBe(false);
    expect(regex.test("not-an-email")).toBe(false);
  });
});
