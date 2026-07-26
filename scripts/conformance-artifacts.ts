import { z } from "zod";
import { AWS_SES_CAPABILITIES } from "../src/adapters/aws-ses-capabilities.js";
import {
  CONFORMANCE_CASES,
  conformanceCaseCatalogSchema,
  conformanceResultSchema,
  providerCapabilityDocumentSchema,
} from "../src/core/provider-capabilities.js";
import { deliveryRecordSchema } from "../src/core/delivery-model.js";

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

export const CONFORMANCE_ARTIFACTS: Readonly<Record<string, unknown>> = {
  "conformance/cases.v1.json": conformanceCaseCatalogSchema.parse({
    schema_version: "1.0.0",
    cases: CONFORMANCE_CASES,
  }),
  "conformance/providers/aws-ses.v1.json": AWS_SES_CAPABILITIES,
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
};
