import { z } from "zod";

const safeString = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), {
    message: "must not contain line breaks",
  });

const address = safeString.max(998);
const recipientList = z
  .union([address, z.array(address).min(1).max(50)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const tag = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+$/),
    value: z.string().min(1).max(256),
  })
  .strict();

const attachmentPresentation = {
  content_type: z.string().min(1).max(255).optional(),
  content_id: z.string().min(1).max(998).optional(),
  content_disposition: z.enum(["inline", "attachment"]).optional(),
};

const inlineAttachment = z
  .object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    ...attachmentPresentation,
  })
  .strict();

const uploadedAttachment = z
  .object({
    attachment_id: z.string().regex(/^att_[a-f0-9]{32}$/),
    filename: z.string().min(1).max(255).optional(),
    ...attachmentPresentation,
  })
  .strict();

const attachment = z.union([inlineAttachment, uploadedAttachment]);

export const attachmentUploadSchema = z
  .object({
    filename: z.string().min(1).max(255),
    content_type: z.string().min(1).max(255),
    size_bytes: z
      .number()
      .int()
      .min(1)
      .max(25 * 1024 * 1024),
    checksum_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();

export const sendEmailSchema = z
  .object({
    from: address.optional(),
    to: recipientList,
    subject: safeString.max(998).optional(),
    html: z.string().min(1).optional(),
    text: z.string().optional(),
    template: z
      .object({
        id: z.string().trim().min(1).max(256),
        variables: z
          .record(
            z.string().regex(/^[A-Za-z0-9_]{1,50}$/),
            z.union([z.string().max(2_000), z.number().finite().safe()]),
          )
          .optional(),
      })
      .strict()
      .optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    reply_to: recipientList.optional(),
    headers: z.record(z.string(), safeString).optional(),
    tags: z.array(tag).max(49).optional(),
    attachments: z.array(attachment).max(20).optional(),
    scheduled_at: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.template) {
      if (value.html !== undefined || value.text !== undefined) {
        context.addIssue({
          code: "custom",
          message: "template cannot be combined with html or text.",
          path: ["template"],
        });
      }
      return;
    }
    if (!value.from) {
      context.addIssue({
        code: "custom",
        message: "from is required when template is not provided.",
        path: ["from"],
      });
    }
    if (!value.subject) {
      context.addIssue({
        code: "custom",
        message: "subject is required when template is not provided.",
        path: ["subject"],
      });
    }
    if (!value.html && !value.text) {
      context.addIssue({
        code: "custom",
        message: "Either html or text is required.",
        path: ["html"],
      });
    }
  });

export const batchEmailSchema = z.array(sendEmailSchema).min(1).max(100);

export const updateEmailSchema = z
  .object({
    scheduled_at: z.string().min(1),
  })
  .strict();

export const domainSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(253)
      .regex(
        /^(?=.{1,253}\.?$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}\.?$/,
        "name must be a valid domain",
      ),
  })
  .strict();

export const webhookEventSchema = z.enum([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.scheduled",
  "email.suppressed",
  "email.received",
]);

export const webhookSchema = z
  .object({
    endpoint: z.url().max(2_048),
    events: z.array(webhookEventSchema).min(1),
  })
  .strict();

export const webhookUpdateSchema = z
  .object({
    endpoint: z.url().max(2_048).optional(),
    events: z.array(webhookEventSchema).min(1).optional(),
    status: z.enum(["enabled", "disabled"]).optional(),
  })
  .strict()
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    {
      message: "At least one webhook field is required.",
    },
  );

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

export const templatePaginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    after: z.string().min(1).optional(),
    before: z.string().min(1).optional(),
  })
  .refine((value) => !(value.after && value.before), {
    message: "after and before cannot be used together.",
  });

export const receivedEmailQuerySchema = z.object({
  html_format: z.enum(["data_uri", "cid"]).default("data_uri"),
});

export const apiScopeSchema = z.enum([
  "emails:send",
  "emails:read",
  "diagnostics:read",
  "templates:read",
  "templates:write",
  "domains:read",
  "domains:write",
  "webhooks:read",
  "webhooks:write",
  "suppressions:read",
  "suppressions:write",
  "api_keys:read",
  "api_keys:write",
]);

const templateVariableSchema = z.discriminatedUnion("type", [
  z
    .object({
      key: z.string().regex(/^[A-Za-z0-9_]{1,50}$/),
      type: z.literal("string"),
      fallback_value: z.string().max(2_000).nullable().optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().regex(/^[A-Za-z0-9_]{1,50}$/),
      type: z.literal("number"),
      fallback_value: z.number().finite().safe().nullable().optional(),
    })
    .strict(),
]);

const templateAlias = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?!tmpl_)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/);

const nullableAddress = address.nullable().optional();
const nullableSubject = safeString.max(998).nullable().optional();
const nullableReplyTo = recipientList.nullable().optional();

export const createTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    html: z.string().min(1),
    text: z
      .string()
      .max(256 * 1024)
      .nullable()
      .optional(),
    alias: templateAlias.nullable().optional(),
    from: nullableAddress,
    subject: nullableSubject,
    reply_to: nullableReplyTo,
    variables: z.array(templateVariableSchema).max(50).optional(),
  })
  .strict();

export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    html: z.string().min(1).optional(),
    text: z
      .string()
      .max(256 * 1024)
      .nullable()
      .optional(),
    alias: templateAlias.nullable().optional(),
    from: nullableAddress,
    subject: nullableSubject,
    reply_to: nullableReplyTo,
    variables: z.array(templateVariableSchema).max(50).optional(),
  })
  .strict()
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    { message: "At least one template field is required." },
  );

export const renderTemplateSchema = z
  .object({
    from: address.optional(),
    subject: safeString.max(998).optional(),
    reply_to: recipientList.optional(),
    variables: z
      .record(
        z.string().regex(/^[A-Za-z0-9_]{1,50}$/),
        z.union([z.string().max(2_000), z.number().finite().safe()]),
      )
      .optional(),
  })
  .strict();

export const apiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(apiScopeSchema).min(1),
    expires_at: z.iso.datetime().optional(),
  })
  .strict();

export const publicApiKeySchema = z
  .object({
    id: z.string().regex(/^key_[a-f0-9]{32}$/),
    name: z.string().trim().min(1).max(100),
    prefix: z.string().min(1),
    scopes: z.array(apiScopeSchema).min(1),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime().optional(),
    revoked_at: z.iso.datetime().optional(),
  })
  .strict();

export const suppressionSchema = z
  .object({
    email: z.email(),
    reason: z.literal("manual").default("manual"),
    detail: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
