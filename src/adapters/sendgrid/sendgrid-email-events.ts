import { EventWebhook } from "@sendgrid/eventwebhook";
import { z } from "zod";
import { UnauthorizedError, ValidationError } from "../../core/errors.js";
import type {
  DeliveryDiagnosticCategory,
  ProviderEventRecord,
} from "../../core/delivery-model.js";
import type { WebhookEventType } from "../../core/types.js";
import type { TransportEventIngress } from "../../ports/transport-event-ingress.js";
import type { EmailService } from "../../services/email-service.js";
import type { SuppressionService } from "../../services/suppression-service.js";

const messageIdSchema = z
  .string()
  .regex(/^email_[A-Za-z0-9_-]{16,128}$/);
const providerIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7E]+$/);
const eventIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\x21-\x7E]+$/);

const sendGridEventSchema = z
  .object({
    email: z.email().max(320),
    timestamp: z
      .number()
      .int()
      .nonnegative()
      .max(253_402_300_799),
    event: z.enum([
      "bounce",
      "click",
      "deferred",
      "delivered",
      "dropped",
      "group_resubscribe",
      "group_unsubscribe",
      "open",
      "processed",
      "spamreport",
      "unsubscribe",
    ]),
    sg_event_id: eventIdSchema,
    sg_message_id: z.string().min(1).max(512).optional(),
    hayasend_message_id: messageIdSchema,
    hayasend_provider_id: providerIdSchema,
  })
  .passthrough();

const sendGridEventBatchSchema = z
  .array(sendGridEventSchema)
  .min(1)
  .max(1_000);

export type SendGridEmailEvent = z.infer<typeof sendGridEventSchema>;

export interface SendGridEventServices {
  emailService: Pick<EmailService, "applyProviderEvent">;
  suppressionService: Pick<SuppressionService, "put">;
}

export interface SendGridEmailEventContext {
  signature?: string | undefined;
  timestamp?: string | undefined;
  received_at?: string | undefined;
}

export interface SendGridSignatureVerifier {
  verify(
    rawBody: Uint8Array,
    signature: string,
    timestamp: string,
  ): boolean;
}

class OfficialSendGridSignatureVerifier
  implements SendGridSignatureVerifier
{
  private readonly helper = new EventWebhook();
  private readonly publicKey;

  constructor(publicKey: string) {
    this.publicKey = this.helper.convertPublicKeyToECDSA(publicKey);
  }

  verify(
    rawBody: Uint8Array,
    signature: string,
    timestamp: string,
  ): boolean {
    return this.helper.verifySignature(
      this.publicKey,
      Buffer.from(rawBody),
      signature,
      timestamp,
    );
  }
}

const EVENT_NORMALIZATION = {
  processed: {
    webhook: "email.sent",
    provider: "accepted",
    terminal: false,
  },
  deferred: {
    webhook: "email.delivery_delayed",
    provider: "delayed",
    terminal: false,
    diagnostic: "provider_unavailable",
  },
  delivered: {
    webhook: "email.delivered",
    provider: "delivered",
    terminal: true,
  },
  bounce: {
    webhook: "email.bounced",
    provider: "bounced",
    terminal: true,
    diagnostic: "provider_rejected",
    suppress: "bounce",
  },
  dropped: {
    webhook: "email.failed",
    provider: "rejected",
    terminal: true,
    diagnostic: "provider_rejected",
  },
  spamreport: {
    webhook: "email.complained",
    provider: "complained",
    terminal: true,
    suppress: "complaint",
  },
  open: {
    webhook: "email.opened",
    provider: "opened",
    terminal: false,
  },
  click: {
    webhook: "email.clicked",
    provider: "clicked",
    terminal: false,
  },
} as const satisfies Record<
  | "bounce"
  | "click"
  | "deferred"
  | "delivered"
  | "dropped"
  | "open"
  | "processed"
  | "spamreport",
  {
    webhook: WebhookEventType;
    provider: ProviderEventRecord["type"];
    terminal: boolean;
    diagnostic?: DeliveryDiagnosticCategory;
    suppress?: "bounce" | "complaint";
  }
>;

const IGNORED_EVENTS = new Set<SendGridEmailEvent["event"]>([
  "group_resubscribe",
  "group_unsubscribe",
  "unsubscribe",
]);

export async function processSendGridEmailEvent(
  event: SendGridEmailEvent,
  services: SendGridEventServices,
  receivedAt = new Date().toISOString(),
): Promise<void> {
  if (IGNORED_EVENTS.has(event.event)) {
    return;
  }
  const normalized =
    EVENT_NORMALIZATION[event.event as keyof typeof EVENT_NORMALIZATION];
  await services.emailService.applyProviderEvent(
    event.hayasend_message_id,
    normalized.webhook,
    {
      provider_event_id: event.sg_event_id,
      provider_message_id: event.hayasend_provider_id,
      provider_at: new Date(event.timestamp * 1_000).toISOString(),
      received_at: new Date(receivedAt).toISOString(),
      recipient_addresses: [event.email],
      provider_type: normalized.provider,
      terminal: normalized.terminal,
      ...("diagnostic" in normalized
        ? { diagnostic_category: normalized.diagnostic }
        : {}),
    },
  );
  if ("suppress" in normalized && normalized.suppress) {
    await services.suppressionService.put({
      email: event.email,
      reason: normalized.suppress,
      source_email_id: event.hayasend_message_id,
    });
  }
}

export class SendGridEmailEventIngress
  implements
    TransportEventIngress<
      Uint8Array,
      SendGridEmailEventContext,
      void
    >
{
  private readonly verifier: SendGridSignatureVerifier;

  constructor(
    private readonly services: SendGridEventServices,
    publicKey: string,
    verifier?: SendGridSignatureVerifier,
  ) {
    this.verifier =
      verifier ?? new OfficialSendGridSignatureVerifier(publicKey);
  }

  async receive(
    rawBody: Uint8Array,
    context: SendGridEmailEventContext = {},
  ): Promise<void> {
    const { signature, timestamp } = context;
    if (
      !signature ||
      signature.length > 512 ||
      !timestamp ||
      !/^\d{1,20}$/.test(timestamp) ||
      !this.verifier.verify(rawBody, signature, timestamp)
    ) {
      throw new UnauthorizedError(
        "The SendGrid Event Webhook signature is invalid or missing.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      throw new ValidationError(
        "Malformed JSON in SendGrid Event Webhook body.",
      );
    }
    const parsed = sendGridEventBatchSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "SendGrid Event Webhook payload is invalid.",
      );
    }
    const receivedAt = context.received_at ?? new Date().toISOString();
    for (const event of parsed.data) {
      await processSendGridEmailEvent(event, this.services, receivedAt);
    }
  }
}
