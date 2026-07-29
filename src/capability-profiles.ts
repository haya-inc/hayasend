import { ValidationError } from "./core/errors.js";

export const PORTABLE_RUNTIME_PROFILES = [
  "portable-postgres",
  "vercel-serverless",
] as const;

export type PortableRuntimeProfile = (typeof PORTABLE_RUNTIME_PROFILES)[number];

export type PortableTransportProfile =
  "console" | "aws-ses" | "azure-communication-services" | "sendgrid";

export const PORTABLE_DEPLOYMENT_PROFILES = {
  "azure-container-apps-acs": {
    runtime: "portable-postgres",
    transport: "azure-communication-services",
  },
  "cloud-run-sendgrid": {
    runtime: "portable-postgres",
    transport: "sendgrid",
  },
  "flyio-sendgrid": {
    runtime: "portable-postgres",
    transport: "sendgrid",
  },
  "railway-sendgrid": {
    runtime: "portable-postgres",
    transport: "sendgrid",
  },
  "render-sendgrid": {
    runtime: "portable-postgres",
    transport: "sendgrid",
  },
  "vercel-sendgrid": {
    runtime: "vercel-serverless",
    transport: "sendgrid",
  },
} as const satisfies Record<
  string,
  {
    runtime: PortableRuntimeProfile;
    transport: PortableTransportProfile;
  }
>;

export type PortableDeploymentProfile =
  keyof typeof PORTABLE_DEPLOYMENT_PROFILES;

function isRuntimeProfile(value: string): value is PortableRuntimeProfile {
  return (PORTABLE_RUNTIME_PROFILES as readonly string[]).includes(value);
}

function isDeploymentProfile(
  value: string,
): value is PortableDeploymentProfile {
  return Object.hasOwn(PORTABLE_DEPLOYMENT_PROFILES, value);
}

export function resolvePortableCapabilityProfiles(input: {
  runtime?: string | undefined;
  deployment?: string | undefined;
  transport: PortableTransportProfile;
}): {
  runtime: PortableRuntimeProfile;
  deployment?: PortableDeploymentProfile;
} {
  const runtime = input.runtime ?? "portable-postgres";
  if (!isRuntimeProfile(runtime)) {
    throw new ValidationError(
      `HAYASEND_RUNTIME_PROFILE must be one of: ${PORTABLE_RUNTIME_PROFILES.join(", ")}.`,
    );
  }
  if (input.deployment === undefined) {
    return { runtime };
  }
  if (!isDeploymentProfile(input.deployment)) {
    throw new ValidationError(
      "HAYASEND_DEPLOYMENT_PROFILE must identify a bundled exact runtime and transport combination.",
    );
  }
  const expected = PORTABLE_DEPLOYMENT_PROFILES[input.deployment];
  if (expected.runtime !== runtime || expected.transport !== input.transport) {
    throw new ValidationError(
      "HAYASEND_DEPLOYMENT_PROFILE does not match the selected runtime and transport.",
    );
  }
  return {
    runtime,
    deployment: input.deployment,
  };
}
