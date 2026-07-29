import { describe, expect, it } from "vitest";
import {
  PORTABLE_DEPLOYMENT_PROFILES,
  resolvePortableCapabilityProfiles,
} from "../src/capability-profiles.js";

describe("portable capability profiles", () => {
  it("keeps existing portable deployments backward compatible", () => {
    expect(
      resolvePortableCapabilityProfiles({
        transport: "console",
      }),
    ).toEqual({
      runtime: "portable-postgres",
    });
  });

  it.each(Object.entries(PORTABLE_DEPLOYMENT_PROFILES))(
    "binds %s to one exact runtime and transport",
    (deployment, expected) => {
      expect(
        resolvePortableCapabilityProfiles({
          runtime: expected.runtime,
          deployment,
          transport: expected.transport,
        }),
      ).toEqual({
        runtime: expected.runtime,
        deployment,
      });
    },
  );

  it("rejects unknown or mismatched declarations", () => {
    expect(() =>
      resolvePortableCapabilityProfiles({
        runtime: "future-runtime",
        transport: "sendgrid",
      }),
    ).toThrow("HAYASEND_RUNTIME_PROFILE");
    expect(() =>
      resolvePortableCapabilityProfiles({
        deployment: "future-deployment",
        transport: "sendgrid",
      }),
    ).toThrow("HAYASEND_DEPLOYMENT_PROFILE");
    expect(() =>
      resolvePortableCapabilityProfiles({
        runtime: "vercel-serverless",
        deployment: "cloud-run-sendgrid",
        transport: "sendgrid",
      }),
    ).toThrow("does not match");
    expect(() =>
      resolvePortableCapabilityProfiles({
        runtime: "vercel-serverless",
        deployment: "vercel-sendgrid",
        transport: "console",
      }),
    ).toThrow("does not match");
  });
});
