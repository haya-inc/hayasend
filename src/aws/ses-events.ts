import type { SNSEvent } from "aws-lambda";
import type { WebhookEventType } from "../core/types.js";
import { emitCountMetric } from "../core/metrics.js";
import {
  createAwsRuntime,
  type Runtime,
} from "../runtime.js";

export interface SesEvent {
  eventType?: string;
  mail?: {
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{
      emailAddress?: string;
      diagnosticCode?: string;
    }>;
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{
      emailAddress?: string;
    }>;
  };
  delivery?: {
    smtpResponse?: string;
  };
  deliveryDelay?: {
    delayType?: string;
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

function getRuntime() {
  runtime ??= createAwsRuntime();
  return runtime;
}

export async function processSesEvent(
  sesEvent: SesEvent,
  services: Pick<Runtime, "emailService" | "suppressionService">,
): Promise<void> {
  const emailId = sesEvent.mail?.tags?.hayasend_id?.[0];
  const eventType = sesEvent.eventType
    ? EVENT_MAP[sesEvent.eventType.toLowerCase()]
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
            ...(recipient.diagnosticCode
              ? { detail: recipient.diagnosticCode.slice(0, 500) }
              : {}),
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
            ...(sesEvent.complaint?.complaintFeedbackType
              ? {
                  detail:
                    sesEvent.complaint.complaintFeedbackType.slice(0, 500),
                }
              : {}),
          }),
        ),
    );
  }
  await services.emailService.applyProviderEvent(emailId, eventType, {
    ...(sesEvent.bounce ?? {}),
    ...(sesEvent.complaint ?? {}),
    ...(sesEvent.delivery ?? {}),
    ...(sesEvent.deliveryDelay ?? {}),
  });
}

export async function handler(event: SNSEvent): Promise<void> {
  const services = getRuntime();
  for (const record of event.Records) {
    await processSesEvent(
      JSON.parse(record.Sns.Message) as SesEvent,
      services,
    );
  }
}
