import { describe, expect, it, vi } from "vitest";
import {
  SendGridApiClient,
  SendGridApiError,
} from "../../src/adapters/sendgrid/sendgrid-api-client.js";

describe("SendGrid API client", () => {
  it("uses a scoped bearer request under the configured v3 origin", async () => {
    const httpFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    const client = new SendGridApiClient(
      "SG.test-key-with-a-safe-length-000000000000",
      "https://api.eu.sendgrid.com",
      httpFetch as typeof fetch,
    );

    await expect(
      client.request({
        method: "POST",
        path: "/v3/mail/send",
        body: { subject: "opaque" },
        expected_statuses: [202],
      }),
    ).resolves.toBeInstanceOf(Response);

    const [url, init] = httpFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.eu.sendgrid.com/v3/mail/send");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer SG.test-key-with-a-safe-length-000000000000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ subject: "opaque" }),
    });
  });

  it.each([
    [400, "provider_rejected", 422],
    [429, "provider_throttled", 429],
    [503, "provider_unavailable", 503],
  ])(
    "classifies HTTP %s without retaining the provider response",
    async (status, category, publicStatus) => {
      const httpFetch = vi.fn(
        async () =>
          new Response(
            "recipient@example.net private-body SG.private-credential",
            { status },
          ),
      );
      const client = new SendGridApiClient(
        "SG.test-key-with-a-safe-length-000000000000",
        "https://api.sendgrid.com",
        httpFetch as typeof fetch,
      );

      const error = await client
        .request({
          method: "GET",
          path: "/v3/whitelabel/domains",
          expected_statuses: [200],
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SendGridApiError);
      expect(error).toMatchObject({
        name: category,
        status: publicStatus,
        provider_status: status,
      });
      expect(String((error as Error).message)).not.toContain(
        "recipient@example.net",
      );
      expect(String((error as Error).message)).not.toContain("private-body");
      expect(String((error as Error).message)).not.toContain("credential");
    },
  );

  it("refuses paths outside the SendGrid v3 API boundary", async () => {
    const client = new SendGridApiClient(
      "SG.test-key-with-a-safe-length-000000000000",
    );
    await expect(
      client.request({
        method: "GET",
        path: "https://attacker.example/private",
        expected_statuses: [200],
      }),
    ).rejects.toThrow("under /v3/");
  });
});
