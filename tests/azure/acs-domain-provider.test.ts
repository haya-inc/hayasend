import { describe, expect, it } from "vitest";
import { AcsDomainProvider } from "../../src/adapters/azure/acs-domain-provider.js";

const domainId =
  "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/proof/providers/Microsoft.Communication/emailServices/email/domains/example.com";

function client(options: {
  linked?: boolean;
  from?: string;
  status?: string;
} = {}) {
  const verificationStatus = options.status ?? "Verified";
  return {
    domains: {
      async get() {
        return {
          id: domainId,
          location: "global",
          provisioningState: "Succeeded",
          fromSenderDomain: options.from ?? "example.com",
          verificationStates: {
            domain: { status: verificationStatus },
            spf: { status: verificationStatus },
            dkim: { status: verificationStatus },
            dkim2: { status: verificationStatus },
          },
          verificationRecords: {
            spf: {
              type: "TXT",
              name: "example.com",
              value: "v=spf1 include:spf.protection.outlook.com -all",
            },
            dkim: {
              type: "CNAME",
              name: "selector1._domainkey.example.com",
              value: "selector1._domainkey.azurecomm.net",
            },
            dkim2: {
              type: "CNAME",
              name: "selector2._domainkey.example.com",
              value: "selector2._domainkey.azurecomm.net",
            },
          },
        };
      },
    },
    communicationServices: {
      async get() {
        return {
          location: "global",
          linkedDomains: options.linked === false ? [] : [domainId],
        };
      },
    },
  };
}

const options = {
  resource_group: "proof",
  email_service_name: "email",
  communication_service_name: "communication",
  domain_resource_name: "example.com",
};

describe("Azure Communication Services domain provider", () => {
  it("reports a verified, linked, operator-owned identity", async () => {
    const provider = new AcsDomainProvider(options, client());
    await expect(provider.create("example.com")).resolves.toMatchObject({
      status: "verified",
      records: [
        { record: "SPF", type: "TXT", status: "verified" },
        { record: "DKIM", type: "CNAME", status: "verified" },
        { record: "DKIM", type: "CNAME", status: "verified" },
      ],
    });
    await expect(provider.delete("example.com")).resolves.toBeUndefined();
  });

  it("reports pending verification without inventing readiness", async () => {
    const provider = new AcsDomainProvider(
      options,
      client({ status: "VerificationInProgress" }),
    );
    await expect(provider.get("example.com")).resolves.toMatchObject({
      status: "pending",
      records: expect.arrayContaining([
        expect.objectContaining({ status: "pending" }),
      ]),
    });
  });

  it.each([
    [{ linked: false }, "not the configured, linked"],
    [{ from: "another.example.com" }, "not the configured, linked"],
  ])("fails closed on identity drift", async (drift, message) => {
    const provider = new AcsDomainProvider(options, client(drift));
    await expect(provider.get("example.com")).rejects.toThrow(message);
  });
});
