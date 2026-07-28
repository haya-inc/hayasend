import { z } from "zod";
import { AWS_RUNTIME_CAPABILITIES } from "../src/adapters/aws-runtime-capabilities.js";
import { AWS_SES_CAPABILITIES } from "../src/adapters/aws-ses-capabilities.js";
import { CLOUDFLARE_EMAIL_CAPABILITIES } from "../src/adapters/cloudflare/cloudflare-email-capabilities.js";
import { ACS_EMAIL_CAPABILITIES } from "../src/adapters/azure/acs-email-capabilities.js";
import { CLOUDFLARE_EMAIL_CONFORMANCE_REPORT } from "../src/adapters/cloudflare/cloudflare-email-conformance.js";
import { CLOUDFLARE_RUNTIME_CAPABILITIES } from "../src/adapters/cloudflare-runtime-capabilities.js";
import { PORTABLE_RUNTIME_CAPABILITIES } from "../src/adapters/portable-runtime-capabilities.js";
import { VERCEL_RUNTIME_CAPABILITIES } from "../src/adapters/vercel-runtime-capabilities.js";
import {
  CONFORMANCE_CASES,
  conformanceCaseCatalogSchema,
  conformanceResultSchema,
  providerCapabilityDocumentSchema,
} from "../src/core/provider-capabilities.js";
import { deliveryRecordSchema } from "../src/core/delivery-model.js";
import {
  buildReadinessMatrix,
  deploymentCapabilityDocumentSchema,
  readinessMatrixSchema,
  runtimeCapabilityDocumentSchema,
} from "../src/core/runtime-capabilities.js";
import { AWS_SES_DEPLOYMENT_CAPABILITIES } from "../src/deployments/aws-ses-capabilities.js";
import { CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES } from "../src/deployments/cloudflare-email-capabilities.js";

function jsonSchema(schema: z.ZodType, id: string) {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "ref",
  });
  return {
    $schema: generated.$schema,
    $id: id,
    ...Object.fromEntries(
      Object.entries(generated).filter(([key]) => key !== "$schema"),
    ),
  };
}

const READINESS_MATRIX = buildReadinessMatrix([
  AWS_SES_DEPLOYMENT_CAPABILITIES,
  CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES,
]);

export const CONFORMANCE_ARTIFACTS: Readonly<Record<string, unknown>> = {
  "conformance/cases.v1.json": conformanceCaseCatalogSchema.parse({
    schema_version: "1.0.0",
    cases: CONFORMANCE_CASES,
  }),
  "conformance/providers/aws-ses.v1.json": AWS_SES_CAPABILITIES,
  "conformance/providers/cloudflare-email.v1.json":
    CLOUDFLARE_EMAIL_CAPABILITIES,
  "conformance/providers/azure-communication-services.v1.json":
    ACS_EMAIL_CAPABILITIES,
  "conformance/runtimes/aws-native.v1.json": AWS_RUNTIME_CAPABILITIES,
  "conformance/runtimes/cloudflare-native.v1.json":
    CLOUDFLARE_RUNTIME_CAPABILITIES,
  "conformance/runtimes/portable-postgres.v1.json":
    PORTABLE_RUNTIME_CAPABILITIES,
  "conformance/runtimes/vercel-serverless.v1.json":
    VERCEL_RUNTIME_CAPABILITIES,
  "conformance/deployments/aws-ses.v1.json":
    AWS_SES_DEPLOYMENT_CAPABILITIES,
  "conformance/deployments/cloudflare-email.v1.json":
    CLOUDFLARE_EMAIL_DEPLOYMENT_CAPABILITIES,
  "conformance/readiness.v1.json": READINESS_MATRIX,
  "conformance/reports/cloudflare-email.local.v1.json":
    CLOUDFLARE_EMAIL_CONFORMANCE_REPORT,
  "schemas/conformance-cases.v1.schema.json": jsonSchema(
    conformanceCaseCatalogSchema,
    "https://hayasend.dev/schemas/conformance-cases.v1.schema.json",
  ),
  "schemas/conformance-result.v1.schema.json": jsonSchema(
    conformanceResultSchema,
    "https://hayasend.dev/schemas/conformance-result.v1.schema.json",
  ),
  "schemas/delivery-record.v1.schema.json": jsonSchema(
    deliveryRecordSchema,
    "https://hayasend.dev/schemas/delivery-record.v1.schema.json",
  ),
  "schemas/provider-capabilities.v1.schema.json": jsonSchema(
    providerCapabilityDocumentSchema,
    "https://hayasend.dev/schemas/provider-capabilities.v1.schema.json",
  ),
  "schemas/runtime-capabilities.v1.schema.json": jsonSchema(
    runtimeCapabilityDocumentSchema,
    "https://hayasend.dev/schemas/runtime-capabilities.v1.schema.json",
  ),
  "schemas/deployment-capabilities.v1.schema.json": jsonSchema(
    deploymentCapabilityDocumentSchema,
    "https://hayasend.dev/schemas/deployment-capabilities.v1.schema.json",
  ),
  "schemas/readiness-matrix.v1.schema.json": jsonSchema(
    readinessMatrixSchema,
    "https://hayasend.dev/schemas/readiness-matrix.v1.schema.json",
  ),
};
