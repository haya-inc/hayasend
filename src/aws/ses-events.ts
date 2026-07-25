import type { SNSEvent } from "aws-lambda";
import type { WebhookEventType } from "../core/types.js";
import { createAwsRuntime } from "../runtime.js";

interface SesEvent {
  eventType?: string;
  mail?: {
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
  };
  complaint?: {
    complaintFeedbackType?: string;
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

const runtime = createAwsRuntime();

export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const sesEvent = JSON.parse(record.Sns.Message) as SesEvent;
    const emailId = sesEvent.mail?.tags?.hayasend_id?.[0];
    const eventType = sesEvent.eventType
      ? EVENT_MAP[sesEvent.eventType.toLowerCase()]
      : undefined;
    if (!emailId || !eventType) {
      continue;
    }
    await runtime.emailService.applyProviderEvent(emailId, eventType, {
      ...(sesEvent.bounce ?? {}),
      ...(sesEvent.complaint ?? {}),
      ...(sesEvent.delivery ?? {}),
      ...(sesEvent.deliveryDelay ?? {}),
    });
  }
}
