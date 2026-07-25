import { z } from "zod";

const safeString = z.string().min(1).refine((value) => !/[\r\n]/.test(value), {
  message: "must not contain line breaks",
});

const address = safeString.max(998);
const recipientList = z
  .union([address, z.array(address).min(1).max(50)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const tag = z
  .object({
    name: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/),
    value: z.string().min(1).max(256),
  })
  .strict();

const attachment = z
  .object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    content_type: z.string().min(1).max(255).optional(),
    content_id: z.string().min(1).max(998).optional(),
    content_disposition: z.enum(["inline", "attachment"]).optional(),
  })
  .strict();

export const sendEmailSchema = z
  .object({
    from: address,
    to: recipientList,
    subject: safeString.max(998),
    html: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    reply_to: recipientList.optional(),
    headers: z.record(z.string(), safeString).optional(),
    tags: z.array(tag).max(49).optional(),
    attachments: z.array(attachment).max(20).optional(),
    scheduled_at: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.html || value.text), {
    message: "Either html or text is required.",
    path: ["html"],
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
    endpoint: z.url(),
    events: z.array(webhookEventSchema).min(1),
  })
  .strict();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

export const apiScopeSchema = z.enum([
  "emails:send",
  "emails:read",
  "domains:read",
  "domains:write",
  "webhooks:read",
  "webhooks:write",
  "suppressions:read",
  "suppressions:write",
  "api_keys:read",
  "api_keys:write",
]);

export const apiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(apiScopeSchema).min(1),
    expires_at: z.iso.datetime().optional(),
  })
  .strict();

export const suppressionSchema = z
  .object({
    email: z.email(),
    reason: z.literal("manual").default("manual"),
    detail: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
