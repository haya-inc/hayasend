import { z } from "zod";

export const DELIVERY_MODEL_SCHEMA_VERSION = "1.0.0" as const;

const semanticVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const providerNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,63}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const messageIdSchema = z
  .string()
  .regex(/^email_[A-Za-z0-9_-]{16,128}$/);
const recipientIdSchema = z
  .string()
  .regex(/^rcpt_[A-Za-z0-9_-]{22,128}$/);
const attemptIdSchema = z
  .string()
  .regex(/^attempt_[A-Za-z0-9_-]{22,128}$/);
const providerOpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s@]+$/);
const providerEventIdentitySchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^provider-event:v1:[^:]+:(?:id|digest):.+$/);
const outboxIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^outbox:v1:[^:]+:[a-z][a-z0-9-]+:[0-9]+$/);

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateUpdatedAt(
  value: { created_at: string; updated_at: string },
  context: z.core.$RefinementCtx,
): void {
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    context.addIssue({
      code: "custom",
      path: ["updated_at"],
      message: "updated_at cannot be before created_at",
    });
  }
}

export const providerReferenceSchema = z
  .object({
    name: providerNameSchema,
    adapter_version: semanticVersionSchema,
    capability_version: semanticVersionSchema,
  })
  .strict();

export const envelopeRoleSchema = z.enum(["to", "cc", "bcc"]);

export const deliveryDiagnosticCategorySchema = z.enum([
  "application_error",
  "invalid_data",
  "network_dns",
  "network_refused",
  "network_reset",
  "provider_error",
  "provider_rejected",
  "provider_throttled",
  "provider_unavailable",
  "timeout",
]);

export const deliveryMessageStatusSchema = z.enum([
  "queued",
  "scheduled",
  "sending",
  "accepted",
  "partially_delivered",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "failed",
  "canceled",
  "suppressed",
]);

export const recipientStatusSchema = z.enum([
  "queued",
  "sending",
  "accepted",
  "delivery_delayed",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "rejected",
  "failed",
  "suppressed",
  "canceled",
]);

export const deliveryAttemptStatusSchema = z.enum([
  "pending",
  "submitting",
  "accepted",
  "ambiguous",
  "retryable_failed",
  "permanent_failed",
]);

export const providerEventTypeSchema = z.enum([
  "accepted",
  "delivered",
  "delayed",
  "bounced",
  "complained",
  "rejected",
  "opened",
  "clicked",
  "failed",
]);

export const outboxJobTypeSchema = z.enum([
  "dispatch-message",
  "wake-scheduled-message",
  "reconcile-message",
]);

export const providerEventSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("provider_event_id"),
      value: providerOpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("normalized_event_digest"),
      value: sha256Schema,
    })
    .strict(),
]);

const deliveryMessageRecordObject = z
  .object({
    schema_version: z.literal(DELIVERY_MODEL_SCHEMA_VERSION),
    record_type: z.literal("message"),
    id: messageIdSchema,
    provider: providerReferenceSchema,
    intent_digest: sha256Schema,
    recipient_ids: z.array(recipientIdSchema).min(1),
    status: deliveryMessageStatusSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
    scheduled_at: timestampSchema.optional(),
  })
  .strict();

export const deliveryMessageRecordSchema =
  deliveryMessageRecordObject.superRefine((value, context) => {
    validateUpdatedAt(value, context);
    if (!unique(value.recipient_ids)) {
      context.addIssue({
        code: "custom",
        path: ["recipient_ids"],
        message: "recipient_ids must be unique",
      });
    }
  });

const recipientRecordObject = z
  .object({
    schema_version: z.literal(DELIVERY_MODEL_SCHEMA_VERSION),
    record_type: z.literal("recipient"),
    id: recipientIdSchema,
    message_id: messageIdSchema,
    role: envelopeRoleSchema,
    ordinal: z.number().int().nonnegative(),
    address: z.email().max(320),
    status: recipientStatusSchema,
    latest_attempt_id: attemptIdSchema.optional(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

export const recipientRecordSchema = recipientRecordObject.superRefine(
  validateUpdatedAt,
);

const deliveryAttemptRecordObject = z
  .object({
    schema_version: z.literal(DELIVERY_MODEL_SCHEMA_VERSION),
    record_type: z.literal("attempt"),
    id: attemptIdSchema,
    message_id: messageIdSchema,
    recipient_ids: z.array(recipientIdSchema).min(1),
    sequence: z.number().int().positive(),
    provider: providerReferenceSchema,
    status: deliveryAttemptStatusSchema,
    provider_message_id: providerOpaqueIdSchema.optional(),
    diagnostic_category: deliveryDiagnosticCategorySchema.optional(),
    started_at: timestampSchema,
    completed_at: timestampSchema.optional(),
  })
  .strict();

export const deliveryAttemptRecordSchema =
  deliveryAttemptRecordObject.superRefine((value, context) => {
    if (!unique(value.recipient_ids)) {
      context.addIssue({
        code: "custom",
        path: ["recipient_ids"],
        message: "recipient_ids must be unique",
      });
    }
    const complete = !["pending", "submitting"].includes(value.status);
    if (complete !== (value.completed_at !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["completed_at"],
        message:
          "completed_at is required exactly when an attempt has completed",
      });
    }
    if (
      value.completed_at !== undefined &&
      Date.parse(value.completed_at) < Date.parse(value.started_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completed_at"],
        message: "completed_at cannot be before started_at",
      });
    }
    if (
      ["retryable_failed", "permanent_failed"].includes(value.status) !==
      (value.diagnostic_category !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["diagnostic_category"],
        message:
          "diagnostic_category is required exactly for classified failures",
      });
    }
  });

const providerEventRecordObject = z
  .object({
    schema_version: z.literal(DELIVERY_MODEL_SCHEMA_VERSION),
    record_type: z.literal("provider_event"),
    id: providerEventIdentitySchema,
    provider: providerReferenceSchema,
    source: providerEventSourceSchema,
    message_id: messageIdSchema,
    attempt_id: attemptIdSchema.optional(),
    recipient_ids: z.array(recipientIdSchema).min(1),
    provider_message_id: providerOpaqueIdSchema.optional(),
    type: providerEventTypeSchema,
    provider_at: timestampSchema,
    received_at: timestampSchema,
    terminal: z.boolean(),
    diagnostic_category: deliveryDiagnosticCategorySchema.optional(),
  })
  .strict();

export const providerEventRecordSchema =
  providerEventRecordObject.superRefine((value, context) => {
    if (!unique(value.recipient_ids)) {
      context.addIssue({
        code: "custom",
        path: ["recipient_ids"],
        message: "recipient_ids must be unique",
      });
    }
    const expectedIdentity = createProviderEventIdentity({
      provider: value.provider.name,
      source: value.source,
    });
    if (value.id !== expectedIdentity) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "provider event identity does not match provider and source",
      });
    }
  });

const outboxItemRecordObject = z
  .object({
    schema_version: z.literal(DELIVERY_MODEL_SCHEMA_VERSION),
    record_type: z.literal("outbox_item"),
    id: outboxIdentitySchema,
    message_id: messageIdSchema,
    job_type: outboxJobTypeSchema,
    generation: z.number().int().nonnegative(),
    due_at: timestampSchema,
    attempts: z.number().int().nonnegative(),
    lease_owner: providerOpaqueIdSchema.optional(),
    lease_expires_at: timestampSchema.optional(),
    dispatched_at: timestampSchema.optional(),
    last_diagnostic_category: deliveryDiagnosticCategorySchema.optional(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict();

export const outboxItemRecordSchema =
  outboxItemRecordObject.superRefine((value, context) => {
    validateUpdatedAt(value, context);
    const expectedIdentity = createOutboxIdentity({
      message_id: value.message_id,
      job_type: value.job_type,
      generation: value.generation,
    });
    if (value.id !== expectedIdentity) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "outbox identity does not match message, job type, and generation",
      });
    }
    if (
      (value.lease_owner === undefined) !==
      (value.lease_expires_at === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["lease_owner"],
        message: "lease owner and expiry must be present together",
      });
    }
    if (
      value.dispatched_at !== undefined &&
      value.lease_owner !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["dispatched_at"],
        message: "a dispatched item cannot retain a lease",
      });
    }
  });

export const deliveryRecordSchema = z
  .union([
    deliveryMessageRecordSchema,
    recipientRecordSchema,
    deliveryAttemptRecordSchema,
    providerEventRecordSchema,
    outboxItemRecordSchema,
  ])
  .meta({
    id: "https://hayasend.dev/schemas/delivery-record.v1.schema.json",
    title: "HayaSend provider-neutral delivery record",
    description:
      "Versioned message, recipient, attempt, provider-event, and outbox records.",
  });

export type ProviderReference = z.infer<typeof providerReferenceSchema>;
export type EnvelopeRole = z.infer<typeof envelopeRoleSchema>;
export type DeliveryDiagnosticCategory = z.infer<
  typeof deliveryDiagnosticCategorySchema
>;
export type DeliveryMessageRecord = z.infer<
  typeof deliveryMessageRecordSchema
>;
export type RecipientRecord = z.infer<typeof recipientRecordSchema>;
export type DeliveryAttemptRecord = z.infer<
  typeof deliveryAttemptRecordSchema
>;
export type ProviderEventSource = z.infer<typeof providerEventSourceSchema>;
export type ProviderEventRecord = z.infer<
  typeof providerEventRecordSchema
>;
export type OutboxJobType = z.infer<typeof outboxJobTypeSchema>;
export type OutboxItemRecord = z.infer<typeof outboxItemRecordSchema>;
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;

function identitySegment(value: string): string {
  return encodeURIComponent(value);
}

export function createProviderEventIdentity(input: {
  provider: string;
  source: ProviderEventSource;
}): string {
  const provider = providerNameSchema.parse(input.provider);
  const source = providerEventSourceSchema.parse(input.source);
  const sourceKind =
    source.kind === "provider_event_id" ? "id" : "digest";
  return providerEventIdentitySchema.parse(
    [
      "provider-event",
      "v1",
      identitySegment(provider),
      sourceKind,
      identitySegment(source.value),
    ].join(":"),
  );
}

export function createOutboxIdentity(input: {
  message_id: string;
  job_type: OutboxJobType;
  generation: number;
}): string {
  const messageId = messageIdSchema.parse(input.message_id);
  const jobType = outboxJobTypeSchema.parse(input.job_type);
  const generation = z.number().int().nonnegative().parse(input.generation);
  return outboxIdentitySchema.parse(
    [
      "outbox",
      "v1",
      identitySegment(messageId),
      jobType,
      generation,
    ].join(":"),
  );
}
