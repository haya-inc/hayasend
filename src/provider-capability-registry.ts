import { AWS_SES_CAPABILITIES } from "./adapters/aws-ses-capabilities.js";
import { ACS_EMAIL_CAPABILITIES } from "./adapters/azure/acs-email-capabilities.js";
import { CLOUDFLARE_EMAIL_CAPABILITIES } from "./adapters/cloudflare/cloudflare-email-capabilities.js";
import { SENDGRID_EMAIL_CAPABILITIES } from "./adapters/sendgrid/sendgrid-email-capabilities.js";
import { sha256 } from "./core/crypto.js";
import type { ProviderCapabilityDocument } from "./core/provider-capabilities.js";

export const PROVIDER_CAPABILITY_DOCUMENTS = [
  ACS_EMAIL_CAPABILITIES,
  AWS_SES_CAPABILITIES,
  CLOUDFLARE_EMAIL_CAPABILITIES,
  SENDGRID_EMAIL_CAPABILITIES,
] as const satisfies readonly ProviderCapabilityDocument[];

const documentsByProvider = new Map(
  PROVIDER_CAPABILITY_DOCUMENTS.map((document) => [
    document.provider,
    document,
  ]),
);

export function providerCapabilityDocument(
  provider: string,
): ProviderCapabilityDocument | undefined {
  return documentsByProvider.get(provider);
}

export function providerCapabilityDocumentDigest(
  provider: string,
): string | undefined {
  const document = providerCapabilityDocument(provider);
  return document ? sha256(JSON.stringify(document)) : undefined;
}
