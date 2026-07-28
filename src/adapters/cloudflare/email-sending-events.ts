import { z } from "zod";
import {
  safeErrorCategory,
  shouldRetryOperationalError,
} from "../../core/error-telemetry.js";
import { AppError, ValidationError } from "../../core/errors.js";
import type {
  DeliveryDiagnosticCategory,
  ProviderEventRecord,
} from "../../core/delivery-model.js";
import type { WebhookEventType } from "../../core/types.js";
import type { TransportEventIngress } from "../../ports/transport-event-ingress.js";
import type { EmailService } from "../../services/email-service.js";
import type { SuppressionService } from "../../services/suppression-service.js";

const cloudflareEmailEventTypeSchema = z.enum([
  "cf.email.sending.message.delivered",
  "cf.email.sending.message.deferred",
  "cf.email.sending.message.bounced",
  "cf.email.sending.message.failed",
  "cf.email.sending.message.rejected",
  "cf.email.sending.message.complained",
]);

const cloudflareDeliveryStatusSchema = z.enum([
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
]);

export const cloudflareEmailSendingEventSchema = z.object({
  type: cloudflareEmailEventTypeSchema,
  source: z.object({
    type: z.literal("email.sending"),
    zoneId: z.string().min(1).max(128),
    domain: z.string().min(1).max(253),
  }),
  payload: z.object({
    eventId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x3F\x41-\x7E]+$/),
    messageId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x3F\x41-\x7E]+$/),
    recipient: z.email().max(320),
    terminal: z.boolean(),
    delivery: z.object({
      status: cloudflareDeliveryStatusSchema,
    }),
  }),
  metadata: z.object({
    accountId: z.string().min(1).max(128),
    eventSubscriptionId: z.string().min(1).max(128),
    eventSchemaVersion: z.number().int().positive(),
    eventTimestamp: z.iso.datetime({ offset: true }),
  }),
}).superRefine((event, context) => {
  const expectedStatus = event.type.slice(
    "cf.email.sending.message.".length,
  );
  if (event.payload.delivery.status !== expectedStatus) {
    context.addIssue({
      code: "custom",
      path: ["payload", "delivery", "status"],
      message: "Delivery status must match the event type.",
    });
  }
});

export type CloudflareEmailSendingEvent = z.infer<
  typeof cloudflareEmailSendingEventSchema
>;

export interface CloudflareProviderMessageResolver {
  findMessageIdByProviderMessageId(
    providerMessageId: string,
  ): Promise<string | undefined>;
}

export interface CloudflareEmailEventServices {
  resolver: CloudflareProviderMessageResolver;
  emailService: Pick<EmailService, "applyProviderEvent">;
  suppressionService: Pick<SuppressionService, "put">;
}

export interface CloudflareEmailEventConsumerOptions {
  retry_delay_seconds?: number | undefined;
  on_diagnostic?:
    | ((diagnostic: {
        category: string;
        disposition: "ack" | "retry";
      }) => void | Promise<void>)
    | undefined;
}

export interface CloudflareEmailEventContext {
  received_at?: string | undefined;
}

export class CloudflareEmailEventIngress
  implements TransportEventIngress<unknown, CloudflareEmailEventContext>
{
  constructor(private readonly services: CloudflareEmailEventServices) {}

  async receive(
    event: unknown,
    context: CloudflareEmailEventContext = {},
  ): Promise<void> {
    await processCloudflareEmailSendingEvent(
      event,
      this.services,
      context.received_at,
    );
  }
}

const EVENT_NORMALIZATION = {
  "cf.email.sending.message.delivered": {
    webhook: "email.delivered",
    provider: "delivered",
  },
  "cf.email.sending.message.deferred": {
    webhook: "email.delivery_delayed",
    provider: "delayed",
    diagnostic: "provider_unavailable",
  },
  "cf.email.sending.message.bounced": {
    webhook: "email.bounced",
    provider: "bounced",
    diagnostic: "provider_rejected",
  },
  "cf.email.sending.message.failed": {
    webhook: "email.failed",
    provider: "failed",
    diagnostic: "provider_error",
  },
  "cf.email.sending.message.rejected": {
    webhook: "email.failed",
    provider: "rejected",
    diagnostic: "provider_rejected",
  },
  "cf.email.sending.message.complained": {
    webhook: "email.complained",
    provider: "complained",
  },
} as const satisfies Record<
  CloudflareEmailSendingEvent["type"],
  {
    webhook: WebhookEventType;
    provider: ProviderEventRecord["type"];
    diagnostic?: DeliveryDiagnosticCategory;
  }
>;

export async function processCloudflareEmailSendingEvent(
  input: unknown,
  services: CloudflareEmailEventServices,
  receivedAt = new Date().toISOString(),
): Promise<void> {
  const parsed = cloudflareEmailSendingEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "Cloudflare Email Sending event payload is invalid.",
    );
  }
  const event = parsed.data;
  const messageId = await services.resolver.findMessageIdByProviderMessageId(
    event.payload.messageId,
  );
  if (!messageId) {
    throw new AppError(
      503,
      "provider_unavailable",
      "Cloudflare Email Sending event is awaiting provider-message correlation.",
    );
  }
  const normalized: {
    webhook: WebhookEventType;
    provider: ProviderEventRecord["type"];
    diagnostic?: DeliveryDiagnosticCategory;
  } = EVENT_NORMALIZATION[event.type];
  await services.emailService.applyProviderEvent(
    messageId,
    normalized.webhook,
    {
      provider_event_id: event.payload.eventId,
      provider_message_id: event.payload.messageId,
      provider_at: event.metadata.eventTimestamp,
      received_at: new Date(receivedAt).toISOString(),
      recipient_addresses: [event.payload.recipient],
      provider_type: normalized.provider,
      terminal: event.payload.terminal,
      ...(normalized.diagnostic
        ? { diagnostic_category: normalized.diagnostic }
      : {}),
    },
  );
  if (normalized.provider === "bounced") {
    await services.suppressionService.put({
      email: event.payload.recipient,
      reason: "bounce",
      source_email_id: messageId,
    });
  } else if (normalized.provider === "complained") {
    await services.suppressionService.put({
      email: event.payload.recipient,
      reason: "complaint",
      source_email_id: messageId,
    });
  }
}

export async function consumeCloudflareEmailEventBatch(
  batch: MessageBatch<unknown>,
  services: CloudflareEmailEventServices,
  options: CloudflareEmailEventConsumerOptions = {},
): Promise<void> {
  const ingress = new CloudflareEmailEventIngress(services);
  const retryDelay = options.retry_delay_seconds ?? 30;
  if (
    !Number.isSafeInteger(retryDelay) ||
    retryDelay < 0 ||
    retryDelay > 86_400
  ) {
    throw new Error(
      "Cloudflare email event retry delay must be between 0 and 86400 seconds.",
    );
  }
  for (const message of batch.messages) {
    try {
      await ingress.receive(
        message.body,
        { received_at: message.timestamp.toISOString() },
      );
      message.ack();
    } catch (error) {
      const retry = shouldRetryOperationalError(error);
      await options.on_diagnostic?.({
        category: safeErrorCategory(error),
        disposition: retry ? "retry" : "ack",
      });
      if (retry) {
        message.retry({ delaySeconds: retryDelay });
      } else {
        message.ack();
      }
    }
  }
}
