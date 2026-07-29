import { describe, expect, it } from "vitest";
import { sha256 } from "../src/core/crypto.js";
import { AWS_SES_DEPLOYMENT_CAPABILITIES } from "../src/deployments/aws-ses-capabilities.js";
import { AZURE_CONTAINER_APPS_ACS_DEPLOYMENT_CAPABILITIES } from "../src/deployments/azure-container-apps-acs-capabilities.js";
import { CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES } from "../src/deployments/cloudflare-email-capabilities.js";
import { SENDGRID_DEPLOYMENT_CAPABILITIES } from "../src/deployments/sendgrid-portable-capabilities.js";
import {
  DEPLOYMENT_CAPABILITY_DOCUMENTS,
  deploymentCapabilityDocument,
  deploymentCapabilityDocumentDigest,
} from "../src/deployment-capability-registry.js";

describe("deployment capability registry", () => {
  it("binds every implemented combination to its committed document", () => {
    expect(DEPLOYMENT_CAPABILITY_DOCUMENTS).toEqual([
      AWS_SES_DEPLOYMENT_CAPABILITIES,
      AZURE_CONTAINER_APPS_ACS_DEPLOYMENT_CAPABILITIES,
      CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES,
      ...SENDGRID_DEPLOYMENT_CAPABILITIES,
    ]);

    for (const document of DEPLOYMENT_CAPABILITY_DOCUMENTS) {
      expect(deploymentCapabilityDocument(document.deployment)).toBe(document);
      expect(deploymentCapabilityDocumentDigest(document.deployment)).toBe(
        sha256(JSON.stringify(document)),
      );
    }
  });

  it("does not invent deployment truth for an extension", () => {
    expect(deploymentCapabilityDocument("customer-deployment")).toBeUndefined();
    expect(
      deploymentCapabilityDocumentDigest("customer-deployment"),
    ).toBeUndefined();
  });
});
