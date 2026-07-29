import { sha256 } from "./core/crypto.js";
import type { DeploymentCapabilityDocument } from "./core/runtime-capabilities.js";
import { AWS_SES_DEPLOYMENT_CAPABILITIES } from "./deployments/aws-ses-capabilities.js";
import { AZURE_CONTAINER_APPS_ACS_DEPLOYMENT_CAPABILITIES } from "./deployments/azure-container-apps-acs-capabilities.js";
import { CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES } from "./deployments/cloudflare-email-capabilities.js";
import { SENDGRID_DEPLOYMENT_CAPABILITIES } from "./deployments/sendgrid-portable-capabilities.js";

export const DEPLOYMENT_CAPABILITY_DOCUMENTS = [
  AWS_SES_DEPLOYMENT_CAPABILITIES,
  AZURE_CONTAINER_APPS_ACS_DEPLOYMENT_CAPABILITIES,
  CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES,
  ...SENDGRID_DEPLOYMENT_CAPABILITIES,
] as const satisfies readonly DeploymentCapabilityDocument[];

const documentsByDeployment = new Map(
  DEPLOYMENT_CAPABILITY_DOCUMENTS.map((document) => [
    document.deployment,
    document,
  ]),
);

export function deploymentCapabilityDocument(
  deployment: string,
): DeploymentCapabilityDocument | undefined {
  return documentsByDeployment.get(deployment);
}

export function deploymentCapabilityDocumentDigest(
  deployment: string,
): string | undefined {
  const document = deploymentCapabilityDocument(deployment);
  return document ? sha256(JSON.stringify(document)) : undefined;
}
