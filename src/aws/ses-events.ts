import type { SNSEvent } from "aws-lambda";
import {
  safeErrorCategory,
  safeRuntimeError,
} from "../core/error-telemetry.js";
import type { WebhookEventType } from "../core/types.js";
import type {
  DeliveryDiagnosticCategory,
  ProviderEventRecord,
} from "../core/delivery-model.js";
import { emitCountMetric } from "../core/metrics.js";
import type { TransportEventIngress } from "../ports/transport-event-ingress.js";
import {
  createAwsRuntime,
  type Runtime,
} from "../runtime.js";

export interface SesEvent {
  eventType?: string;
  mail?: {
    messageId?: string;
    timestamp?: string;
    destination?: string[];
    tags?: Record<string, string[]>;
  };
  bounce?: {
    timestamp?: string;
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{
      emailAddress?: string;
      diagnosticCode?: string;
    }>;
  };
  complaint?: {
    timestamp?: string;
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{
      emailAddress?: string;
    }>;
  };
  delivery?: {
    timestamp?: string;
    recipients?: string[];
    smtpResponse?: string;
  };
  deliveryDelay?: {
    timestamp?: string;
    delayType?: string;
    delayedRecipients?: Array<{
      emailAddress?: string;
      diagnosticCode?: string;
    }>;
  };
  open?: {
    timestamp?: string;
  };
  click?: {
    timestamp?: string;
  };
  reject?: {
    reason?: string;
  };
  failure?: {
    errorMessage?: string;
  };
}

const EVENT_MAP: Record<string, WebhookEventType> = {
  delivery: "email.delivered",
  deliverydelay: "email.delivery_delayed",
  open: "email.opened",
  click: "email.clicked",
  bounce: "email.bounced",
  complaint: "email.complained",
  reject: "email.failed",
  renderingfailure: "email.failed",
};

let runtime: Runtime | undefined;

type SesEventServices = {
  emailService: Pick<Runtime["emailService"], "applyProviderEvent">;
  suppressionService: Pick<Runtime["suppressionService"], "put">;
};

interface SesEventContext {
  providerEventId?: string | undefined;
  receivedAt?: string | undefined;
}

export class SesEventIngress
  implements TransportEventIngress<SesEvent, SesEventContext>
{
  constructor(private readonly services: SesEventServices) {}

  async receive(
    event: SesEvent,
    context: SesEventContext = {},
  ): Promise<void> {
    await processSesEvent(event, this.services, context);
  }
}

function getRuntime() {
  runtime ??= createAwsRuntime();
  return runtime;
}

export async function processSesEvent(
  sesEvent: SesEvent,
  services: SesEventServices,
  context: SesEventContext = {},
): Promise<void> {
  const emailId = sesEvent.mail?.tags?.hayasend_id?.[0];
  const normalizedEventType = sesEvent.eventType?.toLowerCase();
  const eventType = normalizedEventType
    ? EVENT_MAP[normalizedEventType]
    : undefined;
  if (!emailId || !eventType) {
    return;
  }
  if (
    eventType === "email.bounced" &&
    sesEvent.bounce?.bounceType === "Permanent"
  ) {
    emitCountMetric(
      "PermanentBounces",
      sesEvent.bounce.bouncedRecipients?.length ?? 1,
    );
    await Promise.all(
      (sesEvent.bounce.bouncedRecipients ?? [])
        .filter(
          (recipient): recipient is {
            emailAddress: string;
            diagnosticCode?: string;
          } => Boolean(recipient.emailAddress),
        )
        .map((recipient) =>
          services.suppressionService.put({
            email: recipient.emailAddress,
            reason: "bounce",
            source_email_id: emailId,
          }),
        ),
    );
  }
  if (eventType === "email.complained") {
    emitCountMetric(
      "Complaints",
      sesEvent.complaint?.complainedRecipients?.length ?? 1,
    );
    await Promise.all(
      (sesEvent.complaint?.complainedRecipients ?? [])
        .map((recipient) => recipient.emailAddress)
        .filter((email): email is string => Boolean(email))
        .map((email) =>
          services.suppressionService.put({
            email,
            reason: "complaint",
            source_email_id: emailId,
          }),
        ),
    );
  }
  const recipientAddresses = (() => {
    switch (normalizedEventType) {
      case "delivery":
        return sesEvent.delivery?.recipients ?? [];
      case "deliverydelay":
        return (sesEvent.deliveryDelay?.delayedRecipients ?? [])
          .map((recipient) => recipient.emailAddress)
          .filter((address): address is string => Boolean(address));
      case "bounce":
        return (sesEvent.bounce?.bouncedRecipients ?? [])
          .map((recipient) => recipient.emailAddress)
          .filter((address): address is string => Boolean(address));
      case "complaint":
        return (sesEvent.complaint?.complainedRecipients ?? [])
          .map((recipient) => recipient.emailAddress)
          .filter((address): address is string => Boolean(address));
      case "open":
      case "click":
        return sesEvent.mail?.destination?.length === 1
          ? sesEvent.mail.destination
          : [];
      case "reject":
      case "renderingfailure":
        return sesEvent.mail?.destination ?? [];
      default:
        return [];
    }
  })();
  const providerType = (
    {
      delivery: "delivered",
      deliverydelay: "delayed",
      open: "opened",
      click: "clicked",
      bounce: "bounced",
      complaint: "complained",
      reject: "rejected",
      renderingfailure: "failed",
    } satisfies Record<string, ProviderEventRecord["type"]>
  )[normalizedEventType ?? ""];
  const terminal = [
    "delivery",
    "bounce",
    "complaint",
    "reject",
    "renderingfailure",
  ].includes(normalizedEventType ?? "");
  const diagnosticCategory = (
    {
      bounce: "provider_rejected",
      reject: "provider_rejected",
      renderingfailure: "invalid_data",
      deliverydelay: "provider_unavailable",
    } satisfies Record<string, DeliveryDiagnosticCategory>
  )[normalizedEventType ?? ""];
  const providerAt =
    sesEvent.bounce?.timestamp ??
    sesEvent.complaint?.timestamp ??
    sesEvent.delivery?.timestamp ??
    sesEvent.deliveryDelay?.timestamp ??
    sesEvent.open?.timestamp ??
    sesEvent.click?.timestamp ??
    sesEvent.mail?.timestamp ??
    context.receivedAt ??
    new Date().toISOString();
  await services.emailService.applyProviderEvent(emailId, eventType, {
    ...(context.providerEventId
      ? { provider_event_id: context.providerEventId }
      : {}),
    ...(sesEvent.mail?.messageId
      ? { provider_message_id: sesEvent.mail.messageId }
      : {}),
    provider_at: providerAt,
    ...(context.receivedAt ? { received_at: context.receivedAt } : {}),
    recipient_addresses: recipientAddresses,
    ...(providerType ? { provider_type: providerType } : {}),
    terminal,
    ...(diagnosticCategory
      ? { diagnostic_category: diagnosticCategory }
      : {}),
  });
}

export async function processSesRecords(
  event: SNSEvent,
  services: SesEventServices,
): Promise<void> {
  const ingress = new SesEventIngress(services);
  for (const record of event.Records) {
    await ingress.receive(
      JSON.parse(record.Sns.Message) as SesEvent,
      {
        providerEventId: record.Sns.MessageId,
        receivedAt: record.Sns.Timestamp,
      },
    );
  }
}

export async function handleSesEvent(
  event: SNSEvent,
  services: SesEventServices,
): Promise<void> {
  try {
    await processSesRecords(event, services);
  } catch (error) {
    emitCountMetric("SesEventProcessingErrors");
    console.error(
      JSON.stringify({
        level: "error",
        message: "SES event processing failed",
        error_type: safeErrorCategory(error),
      }),
    );
    throw safeRuntimeError("SES event processing failed", error);
  }
}

export async function handler(event: SNSEvent): Promise<void> {
  return handleSesEvent(event, getRuntime());
}
