import type { InboundEmailEvent } from "../core/types.js";
import {
  safeErrorCategory,
  safeRuntimeError,
} from "../core/error-telemetry.js";
import { emitCountMetric } from "../core/metrics.js";
import {
  createAwsRuntime,
  type Runtime,
} from "../runtime.js";
import type { ReceivedEmailService } from "../services/received-email-service.js";

interface SesVerdict {
  status?: string;
}

interface SesInboundPayload {
  mail?: {
    timestamp?: string;
    source?: string;
    messageId?: string;
    destination?: string[];
  };
  receipt?: {
    recipients?: string[];
    spamVerdict?: SesVerdict;
    virusVerdict?: SesVerdict;
    spfVerdict?: SesVerdict;
    dkimVerdict?: SesVerdict;
    dmarcVerdict?: SesVerdict;
  };
}

interface SesInboundRecord {
  eventSource?: string;
  ses?: SesInboundPayload;
}

export interface MailManagerLambdaEvent {
  Records?: SesInboundRecord[];
  mail?: SesInboundPayload["mail"];
  receipt?: SesInboundPayload["receipt"];
}

let runtime: Runtime | undefined;

function getRuntime() {
  runtime ??= createAwsRuntime();
  return runtime;
}

export function normalizeInboundEvent(
  payload: SesInboundPayload,
): InboundEmailEvent {
  const providerMessageId = payload.mail?.messageId;
  const source = payload.mail?.source;
  const timestamp = payload.mail?.timestamp;
  if (!providerMessageId || !source || !timestamp) {
    throw new Error(
      "Inbound SES event is missing mail.messageId, source, or timestamp.",
    );
  }
  const receiptRecipients = [
    ...new Set(payload.receipt?.recipients ?? []),
  ];
  const destinations =
    receiptRecipients.length > 0
      ? receiptRecipients
      : [...new Set(payload.mail?.destination ?? [])];
  if (destinations.length === 0) {
    throw new Error("Inbound SES event does not contain any recipients.");
  }
  return {
    provider_message_id: providerMessageId,
    source,
    destinations,
    timestamp,
    verdicts: {
      ...(payload.receipt?.spamVerdict?.status
        ? { spam: payload.receipt.spamVerdict.status }
        : {}),
      ...(payload.receipt?.virusVerdict?.status
        ? { virus: payload.receipt.virusVerdict.status }
        : {}),
      ...(payload.receipt?.spfVerdict?.status
        ? { spf: payload.receipt.spfVerdict.status }
        : {}),
      ...(payload.receipt?.dkimVerdict?.status
        ? { dkim: payload.receipt.dkimVerdict.status }
        : {}),
      ...(payload.receipt?.dmarcVerdict?.status
        ? { dmarc: payload.receipt.dmarcVerdict.status }
        : {}),
    },
  };
}

export async function processInboundEvent(
  event: MailManagerLambdaEvent,
  services: {
    receivedEmailService: Pick<ReceivedEmailService, "ingest">;
  },
): Promise<void> {
  let records: SesInboundRecord[];
  if (event.Records) {
    records = event.Records;
  } else if (event.mail || event.receipt) {
    const ses: SesInboundPayload = {
      ...(event.mail ? { mail: event.mail } : {}),
      ...(event.receipt ? { receipt: event.receipt } : {}),
    };
    records = [{ ses }];
  } else {
    records = [];
  }
  if (records.length === 0) {
    throw new Error("Inbound SES event does not contain any records.");
  }
  for (const record of records) {
    if (record.eventSource && record.eventSource !== "aws:ses") {
      throw new Error("Inbound event source is not Amazon SES.");
    }
    if (!record.ses) {
      throw new Error("Inbound SES record is missing its payload.");
    }
    await services.receivedEmailService.ingest(
      normalizeInboundEvent(record.ses),
    );
  }
}

export async function handler(
  event: MailManagerLambdaEvent,
): Promise<void> {
  return handleInboundEvent(event, getRuntime());
}

export async function handleInboundEvent(
  event: MailManagerLambdaEvent,
  services: {
    receivedEmailService: Pick<ReceivedEmailService, "ingest">;
  },
): Promise<void> {
  try {
    await processInboundEvent(event, services);
    emitCountMetric("InboundEmailsProcessed");
  } catch (error) {
    emitCountMetric("InboundProcessingErrors");
    console.error(
      JSON.stringify({
        level: "error",
        message: "Inbound email processing failed",
        error_type: safeErrorCategory(error),
      }),
    );
    throw safeRuntimeError("Inbound email processing failed", error);
  }
}
