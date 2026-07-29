import { AWS_RUNTIME_CAPABILITIES } from "./adapters/aws-runtime-capabilities.js";
import { CLOUDFLARE_RUNTIME_CAPABILITIES } from "./adapters/cloudflare-runtime-capabilities.js";
import { PORTABLE_RUNTIME_CAPABILITIES } from "./adapters/portable-runtime-capabilities.js";
import { VERCEL_RUNTIME_CAPABILITIES } from "./adapters/vercel-runtime-capabilities.js";
import { sha256 } from "./core/crypto.js";
import type { RuntimeCapabilityDocument } from "./core/runtime-capabilities.js";

export const RUNTIME_CAPABILITY_DOCUMENTS = [
  AWS_RUNTIME_CAPABILITIES,
  CLOUDFLARE_RUNTIME_CAPABILITIES,
  PORTABLE_RUNTIME_CAPABILITIES,
  VERCEL_RUNTIME_CAPABILITIES,
] as const satisfies readonly RuntimeCapabilityDocument[];

const documentsByRuntime = new Map(
  RUNTIME_CAPABILITY_DOCUMENTS.map((document) => [document.runtime, document]),
);

export function runtimeCapabilityDocument(
  runtime: string,
): RuntimeCapabilityDocument | undefined {
  return documentsByRuntime.get(runtime);
}

export function runtimeCapabilityDocumentDigest(
  runtime: string,
): string | undefined {
  const document = runtimeCapabilityDocument(runtime);
  return document ? sha256(JSON.stringify(document)) : undefined;
}
