import { createId, requestHash, sha256 } from "../core/crypto.js";
import {
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from "../core/errors.js";
import { parseScheduledAt, secondsUntil } from "../core/schedule.js";
import { emitCountMetric } from "../core/metrics.js";
import type {
  CreateEmailResult,
  EmailRecord,
  EmailStatus,
  Page,
  SendEmailInput,
  WebhookEventType,
} from "../core/types.js";
import type { EmailScheduler } from "../ports/email-scheduler.js";
import type { MailTransport } from "../ports/mail-transport.js";
import type { Store } from "../ports/store.js";
import type { SuppressionService } from "./suppression-service.js";
import type { WebhookService } from "./webhook-service.js";

const FINAL_STATUSES = new Set<EmailStatus>([
  "sent",
  "delivered",
  "delivery_delayed",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  "canceled",
  "suppressed",
]);

function ensureSafeHeaderValue(label: string, value: string) {
  if (/[\r\n]/.test(value)) {
    throw new ValidationError(`${label} must not contain line breaks.`);
  }
}

function validateInput(input: SendEmailInput) {
  if (!input.html && !input.text) {
    throw new ValidationError("Either html or text is required.");
  }
  const recipients = [
    ...input.to,
    ...(input.cc ?? []),
    ...(input.bcc ?? []),
  ];
  if (recipients.length === 0 || recipients.length > 50) {
    throw new ValidationError(
      "An email must have between 1 and 50 recipients.",
    );
  }
  ensureSafeHeaderValue("from", input.from);
  ensureSafeHeaderValue("subject", input.subject);
  recipients.forEach((recipient) =>
    ensureSafeHeaderValue("recipient", recipient),
  );
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    ensureSafeHeaderValue("header name", name);
    ensureSafeHeaderValue(`header ${name}`, value);
  }
  const attachmentBytes = (input.attachments ?? []).reduce(
    (total, attachment) =>
      total + Buffer.byteLength(attachment.content, "base64"),
    0,
  );
  if (attachmentBytes > 6 * 1024 * 1024) {
    throw new ValidationError(
      "Decoded attachment content must not exceed 6 MiB.",
    );
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 9 * 1024 * 1024) {
    throw new ValidationError(
      "The serialized request must not exceed 9 MiB.",
    );
  }
}

export class EmailService {
  constructor(
    private readonly store: Store,
    private readonly scheduler: EmailScheduler,
    private readonly transport: MailTransport,
    private readonly webhooks: WebhookService,
    private readonly suppressions: SuppressionService,
  ) {}

  async create(
    input: SendEmailInput,
    idempotencyKey?: string,
    now = new Date(),
  ): Promise<CreateEmailResult> {
    validateInput(input);
    const scheduledAt = parseScheduledAt(input.scheduled_at, now);
    const suppressedRecipients = await this.suppressions.findSuppressed([
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ]);
    const normalized: SendEmailInput = {
      ...input,
      to: [...new Set(input.to)],
      ...(input.cc ? { cc: [...new Set(input.cc)] } : {}),
      ...(input.bcc ? { bcc: [...new Set(input.bcc)] } : {}),
      ...(input.reply_to
        ? { reply_to: [...new Set(input.reply_to)] }
        : {}),
      ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
    };
    const hash = requestHash(normalized);
    const timestamp = now.toISOString();
    const record: EmailRecord = {
      ...normalized,
      id: createId("email"),
      status:
        suppressedRecipients.length > 0
          ? "suppressed"
          : scheduledAt
            ? "scheduled"
            : "queued",
      last_event:
        suppressedRecipients.length > 0
          ? "suppressed"
          : scheduledAt
            ? "scheduled"
            : "queued",
      created_at: timestamp,
      updated_at: timestamp,
      request_hash: hash,
      attempts: 0,
    };
    const idempotency = idempotencyKey
      ? {
          key_hash: sha256(idempotencyKey),
          request_hash: hash,
          expires_at: Math.floor(now.getTime() / 1_000) + 86_400,
        }
      : undefined;
    const created = await this.store.createEmail(record, idempotency);
    if (!created.replayed) {
      if (suppressedRecipients.length > 0) {
        emitCountMetric("SuppressedEmails");
        await this.webhooks.publish("email.suppressed", record, {
          suppressed_recipients: suppressedRecipients.map(
            (suppression) => suppression.email,
          ),
        });
      } else {
        await this.scheduler.schedule(record.id, scheduledAt, now);
      }
      if (scheduledAt && suppressedRecipients.length === 0) {
        await this.webhooks.publish("email.scheduled", record);
      }
    } else if (
      created.record.status === "scheduled" &&
      created.record.scheduled_at &&
      secondsUntil(created.record.scheduled_at, now) > 900
    ) {
      await this.scheduler.schedule(
        created.record.id,
        created.record.scheduled_at,
        now,
      );
    }
    return created;
  }

  async createBatch(
    inputs: SendEmailInput[],
    idempotencyKey?: string,
  ): Promise<CreateEmailResult[]> {
    if (inputs.length === 0 || inputs.length > 100) {
      throw new ValidationError(
        "A batch must contain between 1 and 100 emails.",
      );
    }
    return Promise.all(
      inputs.map((input, index) =>
        this.create(
          input,
          idempotencyKey ? `${idempotencyKey}:${index}` : undefined,
        ),
      ),
    );
  }

  async get(id: string): Promise<EmailRecord> {
    const record = await this.store.getEmail(id);
    if (!record) {
      throw new NotFoundError("Email");
    }
    return record;
  }

  async list(
    limit: number,
    cursor?: string,
  ): Promise<Page<EmailRecord>> {
    return this.store.listEmails(limit, cursor);
  }

  async cancel(id: string): Promise<EmailRecord> {
    const record = await this.get(id);
    if (!["queued", "scheduled"].includes(record.status)) {
      throw new InvalidStateError(
        `Email ${id} cannot be canceled from status ${record.status}.`,
      );
    }
    const updated = await this.store.updateEmail(id, {
      status: "canceled",
      last_event: "canceled",
      updated_at: new Date().toISOString(),
    }, ["queued", "scheduled"]);
    if (!updated) {
      throw new NotFoundError("Email");
    }
    await this.scheduler.cancel(id);
    return updated;
  }

  async reschedule(id: string, scheduledAt: string): Promise<EmailRecord> {
    const record = await this.get(id);
    if (!["queued", "scheduled"].includes(record.status)) {
      throw new InvalidStateError(
        `Email ${id} cannot be rescheduled from status ${record.status}.`,
      );
    }
    const parsed = parseScheduledAt(scheduledAt);
    if (!parsed) {
      throw new ValidationError("scheduled_at is required.");
    }
    const updated = await this.store.updateEmail(id, {
      scheduled_at: parsed,
      status: "scheduled",
      last_event: "scheduled",
      updated_at: new Date().toISOString(),
    }, ["queued", "scheduled"]);
    if (!updated) {
      throw new NotFoundError("Email");
    }
    await this.scheduler.reschedule(id, parsed);
    const current = await this.store.getEmail(id);
    if (
      current?.status === "scheduled" &&
      current.scheduled_at &&
      current.scheduled_at !== parsed
    ) {
      await this.scheduler.reschedule(id, current.scheduled_at);
    }
    return updated;
  }

  async processSend(id: string, attempt = 1): Promise<void> {
    const record = await this.store.getEmail(id);
    if (!record || FINAL_STATUSES.has(record.status)) {
      return;
    }
    const delay = secondsUntil(record.scheduled_at);
    if (record.scheduled_at && delay > 0) {
      await this.scheduler.reschedule(id, record.scheduled_at);
      return;
    }

    const suppressedRecipients = await this.suppressions.findSuppressed([
      ...record.to,
      ...(record.cc ?? []),
      ...(record.bcc ?? []),
    ]);
    if (suppressedRecipients.length > 0) {
      const suppressed = await this.store.updateEmail(
        id,
        {
          status: "suppressed",
          last_event: "suppressed",
          updated_at: new Date().toISOString(),
        },
        ["queued", "scheduled"],
      );
      if (suppressed) {
        emitCountMetric("SuppressedEmails");
        await this.webhooks.publish("email.suppressed", suppressed, {
          suppressed_recipients: suppressedRecipients.map(
            (recipient) => recipient.email,
          ),
        });
      }
      return;
    }

    const sending = await this.store.claimEmailForSend(
      id,
      attempt,
      new Date(),
    );
    if (!sending) {
      return;
    }

    try {
      const result = await this.transport.send(sending);
      const sent = await this.store.updateEmail(id, {
        status: "sent",
        last_event: "sent",
        provider_id: result.provider_id,
        updated_at: new Date().toISOString(),
        error: undefined,
        send_lease_until: undefined,
      }, ["sending"]);
      if (sent) {
        await this.webhooks.publish("email.sent", sent);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalAttempt = attempt >= 3;
      const failed = await this.store.updateEmail(id, {
        status: finalAttempt ? "failed" : "queued",
        last_event: finalAttempt ? "failed" : "retrying",
        updated_at: new Date().toISOString(),
        error: message,
        send_lease_until: undefined,
      }, ["sending"]);
      if (finalAttempt) {
        emitCountMetric("SendFailures");
        if (failed) {
          await this.webhooks.publish("email.failed", failed, {
            error: message,
          });
        }
        return;
      }
      throw error;
    }
  }

  async applyProviderEvent(
    id: string,
    type: WebhookEventType,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const statusByEvent: Partial<Record<WebhookEventType, EmailStatus>> = {
      "email.delivered": "delivered",
      "email.delivery_delayed": "delivery_delayed",
      "email.opened": "opened",
      "email.clicked": "clicked",
      "email.bounced": "bounced",
      "email.complained": "complained",
      "email.failed": "failed",
      "email.suppressed": "suppressed",
    };
    const status = statusByEvent[type];
    if (!status) {
      return;
    }
    const updated = await this.store.updateEmail(id, {
      status,
      last_event: type.slice("email.".length),
      updated_at: new Date().toISOString(),
    });
    if (updated) {
      await this.webhooks.publish(type, updated, extra);
    }
  }
}
