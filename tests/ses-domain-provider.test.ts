import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import {
  LocalDomainProvider,
  SesDomainProvider,
} from "../src/adapters/ses-domain-provider.js";

describe("domain providers", () => {
  it("translates an existing SES identity into the public domain error", async () => {
    const client = {
      async send() {
        throw Object.assign(new Error("Identity already exists"), {
          name: "AlreadyExistsException",
        });
      },
    } as unknown as SESv2Client;
    const provider = new SesDomainProvider(client);

    await expect(provider.create("example.com")).rejects.toMatchObject({
      status: 403,
      name: "validation_error",
      message: "The `example.com` domain has been registered already.",
    });
  });

  it("keeps local duplicate and deletion behavior aligned with SES", async () => {
    const provider = new LocalDomainProvider();

    await expect(provider.create("example.com")).resolves.toMatchObject({
      status: "verified",
    });
    await expect(provider.create("example.com")).rejects.toMatchObject({
      status: 403,
      name: "validation_error",
    });

    await provider.delete("example.com");
    await expect(provider.create("example.com")).resolves.toMatchObject({
      status: "verified",
    });
  });
});
