import { describe, expect, it } from "vitest";
import { AWS_RUNTIME_CAPABILITIES } from "../src/adapters/aws-runtime-capabilities.js";
import { CLOUDFLARE_RUNTIME_CAPABILITIES } from "../src/adapters/cloudflare-runtime-capabilities.js";
import { PORTABLE_RUNTIME_CAPABILITIES } from "../src/adapters/portable-runtime-capabilities.js";
import { VERCEL_RUNTIME_CAPABILITIES } from "../src/adapters/vercel-runtime-capabilities.js";
import { sha256 } from "../src/core/crypto.js";
import {
  RUNTIME_CAPABILITY_DOCUMENTS,
  runtimeCapabilityDocument,
  runtimeCapabilityDocumentDigest,
} from "../src/runtime-capability-registry.js";

describe("runtime capability registry", () => {
  it("binds every implemented runtime to its committed document", () => {
    expect(RUNTIME_CAPABILITY_DOCUMENTS).toEqual([
      AWS_RUNTIME_CAPABILITIES,
      CLOUDFLARE_RUNTIME_CAPABILITIES,
      PORTABLE_RUNTIME_CAPABILITIES,
      VERCEL_RUNTIME_CAPABILITIES,
    ]);

    for (const document of RUNTIME_CAPABILITY_DOCUMENTS) {
      expect(runtimeCapabilityDocument(document.runtime)).toBe(document);
      expect(runtimeCapabilityDocumentDigest(document.runtime)).toBe(
        sha256(JSON.stringify(document)),
      );
    }
  });

  it("does not invent runtime truth for an extension", () => {
    expect(runtimeCapabilityDocument("customer-runtime")).toBeUndefined();
    expect(runtimeCapabilityDocumentDigest("customer-runtime")).toBeUndefined();
  });
});
