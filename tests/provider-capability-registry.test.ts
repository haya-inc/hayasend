import { describe, expect, it } from "vitest";
import { AWS_SES_CAPABILITIES } from "../src/adapters/aws-ses-capabilities.js";
import { ACS_EMAIL_CAPABILITIES } from "../src/adapters/azure/acs-email-capabilities.js";
import { CLOUDFLARE_EMAIL_CAPABILITIES } from "../src/adapters/cloudflare/cloudflare-email-capabilities.js";
import { SENDGRID_EMAIL_CAPABILITIES } from "../src/adapters/sendgrid/sendgrid-email-capabilities.js";
import { sha256 } from "../src/core/crypto.js";
import {
  PROVIDER_CAPABILITY_DOCUMENTS,
  providerCapabilityDocument,
  providerCapabilityDocumentDigest,
} from "../src/provider-capability-registry.js";

describe("provider capability registry", () => {
  it("binds every implemented transport to its committed document", () => {
    expect(PROVIDER_CAPABILITY_DOCUMENTS).toEqual([
      ACS_EMAIL_CAPABILITIES,
      AWS_SES_CAPABILITIES,
      CLOUDFLARE_EMAIL_CAPABILITIES,
      SENDGRID_EMAIL_CAPABILITIES,
    ]);

    for (const document of PROVIDER_CAPABILITY_DOCUMENTS) {
      expect(providerCapabilityDocument(document.provider)).toBe(document);
      expect(providerCapabilityDocumentDigest(document.provider)).toBe(
        sha256(JSON.stringify(document)),
      );
    }
  });

  it("reports an unknown extension without inventing capability truth", () => {
    expect(providerCapabilityDocument("customer-extension")).toBeUndefined();
    expect(
      providerCapabilityDocumentDigest("customer-extension"),
    ).toBeUndefined();
  });
});
