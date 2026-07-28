import { z } from "zod";
import { AppError, ValidationError } from "../../core/errors.js";
import type {
  DeliveryDiagnosticCategory,
  ProviderEventRecord,
} from "../../core/delivery-model.js";
import type { WebhookEventType } from "../../core/types.js";
import type { TransportEventIngress } from "../../ports/transport-event-ingress.js";
import type { EmailService } from "../../services/email-service.js";
import type { SuppressionService } from "../../services/suppression-service.js";

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x3F\x41-\x7E]+$/);
const timestampSchema = z.iso.datetime({ offset: true });

const eventGridEnvelope = {
  id: opaqueIdSchema,
  topic: z.string().min(1).max(2_048),
  subject: z.string().min(1).max(2_048),
  eventTime: timestampSchema,
  dataVersion: z.string().min(1).max(32),
  metadataVersion: z.string().min(1).max(32),
};

const subscriptionValidationEventSchema = z.object({
  ...eventGridEnvelope,
  eventType: z.literal("Microsoft.EventGrid.SubscriptionValidationEvent"),
  data: z.object({
    validationCode: opaqueIdSchema,
    validationUrl: z.url().optional(),
  }),
});

const deliveryStatusSchema = z.enum([
  "Delivered",
  "Suppressed",
  "Bounced",
  "Quarantined",
  "FilteredSpam",
  "Expanded",
  "Failed",
]);

export const acsEmailDeliveryEventSchema = z.object({
  ...eventGridEnvelope,
  eventType: z.literal(
    "Microsoft.Communication.EmailDeliveryReportReceived",
  ),
  data: z.object({
    sender: z.email().max(320),
    recipient: z.email().max(320),
    messageId: opaqueIdSchema,
    status: deliveryStatusSchema,
    deliveryStatusDetails: z
      .object({
        statusMessage: z.string().max(2_048).optional(),
      })
      .optional(),
    deliveryAttemptTimeStamp: timestampSchema,
  }),
});

export const acsEmailEngagementEventSchema = z.object({
  ...eventGridEnvelope,
  eventType: z.literal(
    "Microsoft.Communication.EmailEngagementTrackingReportReceived",
  ),
  data: z.object({
    sender: z.email().max(320),
    messageId: opaqueIdSchema,
    userActionTimeStamp: timestampSchema,
    engagementContext: z.string().max(2_048).optional(),
    userAgent: z.string().max(2_048).optional(),
    engagementType: z.enum(["view", "click"]),
  }),
});

const acsEventGridBatchSchema = z
  .array(
    z.union([
      subscriptionValidationEventSchema,
      acsEmailDeliveryEventSchema,
      acsEmailEngagementEventSchema,
    ]),
  )
  .min(1)
  .max(100);

export type AcsEmailDeliveryEvent = z.infer<
  typeof acsEmailDeliveryEventSchema
>;
export type AcsEmailEngagementEvent = z.infer<
  typeof acsEmailEngagementEventSchema
>;

export interface AcsProviderMessageResolver {
  findMessageIdByProviderMessageId(
    providerMessageId: string,
  ): Promise<string | undefined>;
}

export interface AcsEmailEventServices {
  resolver: AcsProviderMessageResolver;
  emailService: Pick<EmailService, "applyProviderEvent">;
  suppressionService: Pick<SuppressionService, "put">;
}

export interface AcsEmailEventContext {
  received_at?: string | undefined;
}

export interface AcsEmailEventIngressResult {
  validation_response?: string | undefined;
}

const DELIVERY_NORMALIZATION = {
  Delivered: {
    webhook: "email.delivered",
    provider: "delivered",
    terminal: true,
  },
  Suppressed: {
    webhook: "email.failed",
    provider: "failed",
    terminal: true,
    diagnostic: "provider_rejected",
    suppress: true,
  },
  Bounced: {
    webhook: "email.bounced",
    provider: "bounced",
    terminal: true,
    diagnostic: "provider_rejected",
    suppress: true,
  },
  Quarantined: {
    webhook: "email.failed",
    provider: "rejected",
    terminal: true,
    diagnostic: "provider_rejected",
  },
  FilteredSpam: {
    webhook: "email.failed",
    provider: "rejected",
    terminal: true,
    diagnostic: "provider_rejected",
  },
  Expanded: {
    webhook: "email.delivery_delayed",
    provider: "delayed",
    terminal: false,
  },
  Failed: {
    webhook: "email.failed",
    provider: "failed",
    terminal: true,
    diagnostic: "provider_error",
  },
} as const satisfies Record<
  AcsEmailDeliveryEvent["data"]["status"],
  {
    webhook: WebhookEventType;
    provider: ProviderEventRecord["type"];
    terminal: boolean;
    diagnostic?: DeliveryDiagnosticCategory;
    suppress?: boolean;
  }
>;

async function resolveMessage(
  providerMessageId: string,
  resolver: AcsProviderMessageResolver,
): Promise<string> {
  const messageId =
    await resolver.findMessageIdByProviderMessageId(providerMessageId);
  if (!messageId) {
    throw new AppError(
      503,
      "provider_unavailable",
      "Azure Communication Services Email event is awaiting provider-message correlation.",
    );
  }
  return messageId;
}

export async function processAcsEmailDeliveryEvent(
  event: AcsEmailDeliveryEvent,
  services: AcsEmailEventServices,
  receivedAt = new Date().toISOString(),
): Promise<void> {
  const messageId = await resolveMessage(
    event.data.messageId,
    services.resolver,
  );
  const normalized = DELIVERY_NORMALIZATION[event.data.status];
  await services.emailService.applyProviderEvent(
    messageId,
    normalized.webhook,
    {
      provider_event_id: event.id,
      provider_message_id: event.data.messageId,
      provider_at: event.data.deliveryAttemptTimeStamp,
      received_at: new Date(receivedAt).toISOString(),
      recipient_addresses: [event.data.recipient],
      provider_type: normalized.provider,
      terminal: normalized.terminal,
      ...("diagnostic" in normalized
        ? { diagnostic_category: normalized.diagnostic }
        : {}),
    },
  );
  if ("suppress" in normalized && normalized.suppress) {
    await services.suppressionService.put({
      email: event.data.recipient,
      reason: "bounce",
      source_email_id: messageId,
    });
  }
}

export async function processAcsEmailEngagementEvent(
  event: AcsEmailEngagementEvent,
  services: AcsEmailEventServices,
  receivedAt = new Date().toISOString(),
): Promise<void> {
  const messageId = await resolveMessage(
    event.data.messageId,
    services.resolver,
  );
  const clicked = event.data.engagementType === "click";
  await services.emailService.applyProviderEvent(
    messageId,
    clicked ? "email.clicked" : "email.opened",
    {
      provider_event_id: event.id,
      provider_message_id: event.data.messageId,
      provider_at: event.data.userActionTimeStamp,
      received_at: new Date(receivedAt).toISOString(),
      provider_type: clicked ? "clicked" : "opened",
      terminal: false,
    },
  );
}

export class AcsEmailEventGridIngress
  implements
    TransportEventIngress<
      unknown,
      AcsEmailEventContext,
      AcsEmailEventIngressResult
    >
{
  constructor(
    private readonly services: AcsEmailEventServices,
    private readonly options: {
      expected_topic?: string | undefined;
    } = {},
  ) {}

  async receive(
    input: unknown,
    context: AcsEmailEventContext = {},
  ): Promise<AcsEmailEventIngressResult> {
    const parsed = acsEventGridBatchSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Azure Event Grid email event payload is invalid.",
      );
    }
    if (
      this.options.expected_topic &&
      parsed.data.some(
        (event) =>
          normalizeAzureResourceId(event.topic) !==
          normalizeAzureResourceId(this.options.expected_topic!),
      )
    ) {
      throw new ValidationError(
        "Azure Event Grid event topic does not match the configured Communication Services resource.",
      );
    }
    const validationEvents = parsed.data.filter(
      (event) =>
        event.eventType ===
        "Microsoft.EventGrid.SubscriptionValidationEvent",
    );
    if (validationEvents.length > 0) {
      if (parsed.data.length !== 1 || validationEvents.length !== 1) {
        throw new ValidationError(
          "Azure Event Grid subscription validation must be the only event in its batch.",
        );
      }
      return {
        validation_response: validationEvents[0]!.data.validationCode,
      };
    }
    const receivedAt = context.received_at ?? new Date().toISOString();
    for (const event of parsed.data) {
      if (
        event.eventType ===
        "Microsoft.Communication.EmailDeliveryReportReceived"
      ) {
        await processAcsEmailDeliveryEvent(event, this.services, receivedAt);
      } else if (
        event.eventType ===
        "Microsoft.Communication.EmailEngagementTrackingReportReceived"
      ) {
        await processAcsEmailEngagementEvent(event, this.services, receivedAt);
      }
    }
    return {};
  }
}

function normalizeAzureResourceId(value: string): string {
  return value.replace(/\/+$/, "").toLowerCase();
}
