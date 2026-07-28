import { describe, expect, it, vi } from "vitest";
import { SendGridDomainProvider } from "../../src/adapters/sendgrid/sendgrid-domain-provider.js";
import type {
  SendGridApi,
  SendGridApiRequest,
} from "../../src/adapters/sendgrid/sendgrid-api-client.js";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const domain = {
  id: 42,
  domain: "example.com",
  valid: false,
  dns: {
    mail_cname: {
      valid: false,
      type: "cname",
      host: "em.example.com",
      data: "u42.wl.sendgrid.net",
    },
    dkim1: {
      valid: true,
      type: "cname",
      host: "s1._domainkey.example.com",
      data: "s1.domainkey.u42.wl.sendgrid.net",
    },
    dkim2: {
      valid: false,
      type: "cname",
      host: "s2._domainkey.example.com",
      data: "s2.domainkey.u42.wl.sendgrid.net",
    },
  },
};

describe("SendGrid authenticated-domain provider", () => {
  it("creates an exact domain and exposes only required DNS evidence", async () => {
    const request = vi.fn(
      async (input: SendGridApiRequest): Promise<Response> => {
        if (input.method === "GET") {
          return response([]);
        }
        return response(domain, 201);
      },
    );
    const provider = new SendGridDomainProvider({ request });

    await expect(provider.create("Example.COM.")).resolves.toEqual({
      status: "pending",
      records: [
        {
          record: "SPF",
          name: "em.example.com",
          type: "CNAME",
          value: "u42.wl.sendgrid.net",
          status: "pending",
        },
        {
          record: "DKIM",
          name: "s1._domainkey.example.com",
          type: "CNAME",
          value: "s1.domainkey.u42.wl.sendgrid.net",
          status: "verified",
        },
        {
          record: "DKIM",
          name: "s2._domainkey.example.com",
          type: "CNAME",
          value: "s2.domainkey.u42.wl.sendgrid.net",
          status: "pending",
        },
      ],
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/v3/whitelabel/domains",
      body: {
        domain: "example.com",
        automatic_security: true,
      },
      expected_statuses: [201],
    });
  });

  it("reads and deletes only one exact authenticated domain", async () => {
    const request = vi.fn(
      async (input: SendGridApiRequest): Promise<Response> => {
        if (input.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return response([
          { ...domain, valid: true },
          { ...domain, id: 43, domain: "sub.example.com" },
        ]);
      },
    );
    const provider = new SendGridDomainProvider({ request });

    await expect(provider.get("example.com")).resolves.toMatchObject({
      status: "verified",
    });
    await expect(provider.delete("example.com")).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith({
      method: "DELETE",
      path: "/v3/whitelabel/domains/42",
      expected_statuses: [204],
    });
  });

  it("fails closed on missing or ambiguous exact identities", async () => {
    const missing: SendGridApi = {
      async request() {
        return response([]);
      },
    };
    await expect(
      new SendGridDomainProvider(missing).get("example.com"),
    ).rejects.toThrow("not authenticated");

    const ambiguous: SendGridApi = {
      async request() {
        return response([domain, { ...domain, id: 43 }]);
      },
    };
    await expect(
      new SendGridDomainProvider(ambiguous).get("example.com"),
    ).rejects.toThrow("more than one exact");
  });

  it("searches every documented domain page before reporting absence", async () => {
    const request = vi.fn(
      async (input: SendGridApiRequest): Promise<Response> => {
        if (input.path.includes("offset=0")) {
          return response(
            Array.from({ length: 200 }, (_, index) => ({
              ...domain,
              id: index + 1,
              domain: `sub-${index}.example.com`,
            })),
          );
        }
        return response([{ ...domain, valid: true }]);
      },
    );
    await expect(
      new SendGridDomainProvider({ request }).get("example.com"),
    ).resolves.toMatchObject({ status: "verified" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0].path).toContain("offset=200");
  });
});
