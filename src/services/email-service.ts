import { z } from "zod";
import {
  bytesToBase64,
  utf8ByteLength,
} from "../core/bytes.js";
import { createId, requestHash, sha256 } from "../core/crypto.js";
import {
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from "../core/errors.js";
import {
  safeErrorCategory,
  safeFailureMessage,
  shouldRetryOperationalError,
} from "../core/error-telemetry.js";
import { plainTextFromHtml } from "../core/email-content.js";
import {
  createProviderEventIdentity,
  createOutboxIdentity,
  deliveryDiagnosticCategorySchema,
  type DeliveryAttemptRecord,
  type DeliveryDiagnosticCategory,
  type EnvelopeRole,
  type ProviderEventRecord,
  type ProviderReference,
  type RecipientRecord,
} from "../core/delivery-model.js";
import { deriveDeliveryMessageStatus } from "../core/recipient-ledger.js";
import { parseScheduledAt, secondsUntil } from "../core/schedule.js";
import { emitCountMetric } from "../core/metrics.js";
import type {
  CreateEmailResult,
  EmailRecord,
  EmailStatus,
  IdempotencyClaim,
  Page,
  SendEmailInput,
  SuppressionRecord,
  WebhookEventType,
} from "../core/types.js";
import type { EmailScheduler } from "../ports/email-scheduler.js";
import type { MailTransport } from "../ports/mail-transport.js";
import type { Store } from "../ports/store.js";
import type { AttachmentService } from "./attachment-service.js";
import type { SuppressionService } from "./suppression-service.js";
import type { WebhookService } from "./webhook-service.js";
import type { TemplateService } from "./template-service.js";
import { normalizeMailbox } from "./suppression-service.js";
import { HAYASEND_VERSION } from "../version.js";

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
const MAX_SERIALIZED_EMAIL_BYTES = 9 * 1024 * 1024;

const DEFAULT_PROVIDER: ProviderReference = {
  name: "aws-ses",
  adapter_version: HAYASEND_VERSION,
  capability_version: "1.0.0",
};

export interface EmailServiceOptions {
  provider?: ProviderReference | undefined;
}

export interface NormalizedProviderEvent {
  provider_event_id?: string | undefined;
  provider_message_id?: string | undefined;
  provider_at: string;
  received_at?: string | undefined;
  recipient_addresses?: string[] | undefined;
  provider_type?: ProviderEventRecord["type"] | undefined;
  terminal?: boolean | undefined;
  diagnostic_category?: DeliveryDiagnosticCategory | undefined;
}

export type RecipientRecoveryState =
  | "pending"
  | "in_progress"
  | "awaiting_event"
  | "retryable"
  | "ambiguous"
  | "settled";

export interface RecipientSummary {
  id: string;
  role: EnvelopeRole;
  ordinal: number;
  status: RecipientRecord["status"];
  recovery_state: RecipientRecoveryState;
  requires_operator_attention: boolean;
  latest_attempt: {
    id: string;
    sequence: number;
    status: DeliveryAttemptRecord["status"];
    diagnostic_category: DeliveryDiagnosticCategory | null;
    started_at: string;
    completed_at: string | null;
  } | null;
  updated_at: string;
}

export interface RecipientSummaryPage extends Page<RecipientSummary> {
  message_id: string;
  aggregate_status: ReturnType<typeof deriveDeliveryMessageStatus>;
  recipient_count: number;
  attempt_summary: Record<DeliveryAttemptRecord["status"], number>;
  unattributed_event_count: number;
}

interface NormalizedRecipients {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
}

const envelopeAddressSchema = z.email().max(320);
const ATTEMPT_AMBIGUITY_AFTER_SECONDS = 60;

function recoveryState(
  recipient: RecipientRecord,
  attempt: DeliveryAttemptRecord | undefined,
  now: Date,
): RecipientRecoveryState {
  if (
    attempt?.status === "ambiguous" ||
    (attempt?.status === "submitting" &&
      now.getTime() - Date.parse(attempt.started_at) >=
        ATTEMPT_AMBIGUITY_AFTER_SECONDS * 1_000)
  ) {
    return "ambiguous";
  }
  if (attempt?.status === "retryable_failed") {
    return "retryable";
  }
  if (
    attempt?.status === "pending" ||
    attempt?.status === "submitting" ||
    recipient.status === "sending"
  ) {
    return "in_progress";
  }
  if (
    recipient.status === "accepted" ||
    recipient.status === "delivery_delayed"
  ) {
    return "awaiting_event";
  }
  if (recipient.status === "queued") {
    return "pending";
  }
  return "settled";
}

function requiresOperatorAttention(
  recipient: RecipientRecord,
  recovery: RecipientRecoveryState,
): boolean {
  return (
    recovery === "ambiguous" ||
    [
      "bounced",
      "complained",
      "rejected",
      "failed",
    ].includes(recipient.status)
  );
}

function normalizeEnvelopeAddress(value: string): string {
  const normalized = normalizeMailbox(value);
  if (!envelopeAddressSchema.safeParse(normalized).success) {
    throw new ValidationError(`Invalid email address: ${value}`);
  }
  return normalized;
}

function normalizeRecipients(input: SendEmailInput): NormalizedRecipients {
  const seen = new Set<string>();
  const collect = (values: string[] | undefined) =>
    (values ?? []).filter((value) => {
      const address = normalizeEnvelopeAddress(value);
      if (seen.has(address)) {
        return false;
      }
      seen.add(address);
      return true;
    });
  const to = collect(input.to);
  const cc = collect(input.cc);
  const bcc = collect(input.bcc);
  return {
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
  };
}

function ensureSafeHeaderValue(label: string, value: string) {
  if (/[\r\n]/.test(value)) {
    throw new ValidationError(`${label} must not contain line breaks.`);
  }
  if (utf8ByteLength(value) > 998) {
    throw new ValidationError(`${label} must not exceed 998 bytes.`);
  }
}

function validateInput(
  input: SendEmailInput,
): asserts input is SendEmailInput & { from: string; subject: string } {
  if (input.template) {
    throw new ValidationError(
      "Template input must be resolved before sending.",
    );
  }
  if (!input.from || !input.subject) {
    throw new ValidationError("from and subject are required.");
  }
  if (!input.html && !input.text) {
    throw new ValidationError("Either html or text is required.");
  }
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
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
  for (const replyTo of input.reply_to ?? []) {
    ensureSafeHeaderValue("reply_to", replyTo);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (name.toLowerCase() === "message-id") {
      throw new ValidationError(
        "Message-ID is assigned by the delivery provider.",
      );
    }
    ensureSafeHeaderValue("header name", name);
    ensureSafeHeaderValue(`header ${name}`, value);
  }
  if (
    utf8ByteLength(JSON.stringify(input)) >
    MAX_SERIALIZED_EMAIL_BYTES
  ) {
    throw new ValidationError("The serialized request must not exceed 9 MiB.");
  }
}

interface PreparedEmail {
  record: EmailRecord;
  idempotency: IdempotencyClaim | undefined;
  scheduledAt: string | undefined;
  suppressedRecipients: SuppressionRecord[];
}

function idempotencyAttachments(
  attachments: EmailRecord["attachments"],
) {
  return attachments?.map((attachment) => {
    if (!attachment.attachment_id) {
      return attachment;
    }
    const {
      attachment_id: _attachmentId,
      object_key: _objectKey,
      content: _content,
      ...stable
    } = attachment;
    return stable;
  });
}

export class EmailService {
  constructor(
    private readonly store: Store,
    private readonly scheduler: EmailScheduler,
    private readonly transport: MailTransport,
    private readonly webhooks: WebhookService,
    private readonly suppressions: SuppressionService,
    private readonly attachments: AttachmentService,
    private readonly templates?: TemplateService,
    private readonly options: EmailServiceOptions = {},
  ) {}

  async create(
    input: SendEmailInput,
    idempotencyKey?: string,
    now = new Date(),
  ): Promise<CreateEmailResult> {
    return this.commitPreparedEmail(
      await this.prepareEmail(input, idempotencyKey, now),
      now,
    );
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
    if (
      utf8ByteLength(JSON.stringify(inputs)) >
      MAX_SERIALIZED_EMAIL_BYTES
    ) {
      throw new ValidationError(
        "The serialized batch request must not exceed 9 MiB.",
      );
    }
    const now = new Date();
    const prepared = await Promise.all(
      inputs.map((input, index) =>
        this.prepareEmail(
          input,
          idempotencyKey ? `${idempotencyKey}:${index}` : undefined,
          now,
        ),
      ),
    );
    return Promise.all(
      prepared.map((email) => this.commitPreparedEmail(email, now)),
    );
  }

  private async prepareEmail(
    input: SendEmailInput,
    idempotencyKey: string | undefined,
    now: Date,
  ): Promise<PreparedEmail> {
    const templateRequest = input.template
      ? (() => {
          const {
            attachments: _attachments,
            ...request
          } = input;
          return request;
        })()
      : undefined;
    if (input.template) {
      if (!this.templates) {
        throw new ValidationError("Hosted templates are unavailable.");
      }
      input = await this.templates.resolveForSend(input);
    }
    validateInput(input);
    const contentInput =
      input.html !== undefined && input.text === undefined
        ? {
            ...input,
            text: plainTextFromHtml(input.html, MAX_SERIALIZED_EMAIL_BYTES),
          }
        : input;
    const scheduledAt = parseScheduledAt(contentInput.scheduled_at, now);
    const resolvedAttachments = await this.attachments.resolve(
      contentInput.attachments,
      utf8ByteLength(contentInput.html ?? "") +
        utf8ByteLength(contentInput.text ?? ""),
      now,
    );
    const suppressedRecipients = await this.suppressions.findSuppressed([
      ...contentInput.to,
      ...(contentInput.cc ?? []),
      ...(contentInput.bcc ?? []),
    ]);
    const recipients = normalizeRecipients(contentInput);
    const { attachments: _inputAttachments, ...emailInput } = contentInput;
    const normalized = {
      ...emailInput,
      ...recipients,
      ...(contentInput.reply_to
        ? { reply_to: [...new Set(contentInput.reply_to)] }
        : {}),
      ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
      ...(resolvedAttachments ? { attachments: resolvedAttachments } : {}),
    };
    const stableAttachments = idempotencyAttachments(
      resolvedAttachments,
    );
    const hash = requestHash(
      templateRequest
        ? {
            ...templateRequest,
            ...(stableAttachments
              ? { attachments: stableAttachments }
              : {}),
          }
        : {
            ...normalized,
            ...(stableAttachments
              ? { attachments: stableAttachments }
              : {}),
          },
    );
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
    return {
      record,
      idempotency,
      scheduledAt,
      suppressedRecipients,
    };
  }

  private async commitPreparedEmail(
    {
      record,
      idempotency,
      scheduledAt,
      suppressedRecipients,
    }: PreparedEmail,
    now: Date,
  ): Promise<CreateEmailResult> {
    const timestamp = record.created_at;
    const recipientInputs: Array<{
      role: EnvelopeRole;
      ordinal: number;
      address: string;
    }> = [];
    for (const role of ["to", "cc", "bcc"] as const) {
      for (const [ordinal, address] of (record[role] ?? []).entries()) {
        recipientInputs.push({
          role,
          ordinal,
          address: normalizeEnvelopeAddress(address),
        });
      }
    }
    const recipients: RecipientRecord[] = recipientInputs.map((recipient) => ({
      schema_version: "1.0.0",
      record_type: "recipient",
      id: createId("rcpt"),
      message_id: record.id,
      ...recipient,
      status: record.status === "suppressed" ? "suppressed" : "queued",
      created_at: timestamp,
      updated_at: timestamp,
    }));
    const outboxId = createOutboxIdentity({
      message_id: record.id,
      job_type: "dispatch-message",
      generation: 0,
    });
    const created = await this.store.commitDelivery(
      {
        email: record,
        message: {
          schema_version: "1.0.0",
          record_type: "message",
          id: record.id,
          provider: this.options.provider ?? DEFAULT_PROVIDER,
          intent_digest: record.request_hash,
          recipient_ids: recipients.map((recipient) => recipient.id),
          status:
            record.status === "suppressed"
              ? "suppressed"
              : record.status === "scheduled"
                ? "scheduled"
                : "queued",
          created_at: timestamp,
          updated_at: timestamp,
          ...(record.scheduled_at
            ? { scheduled_at: record.scheduled_at }
            : {}),
        },
        recipients,
        outbox: {
          schema_version: "1.0.0",
          record_type: "outbox_item",
          id: outboxId,
          message_id: record.id,
          job_type: "dispatch-message",
          generation: 0,
          due_at: record.scheduled_at ?? timestamp,
          attempts: 0,
          ...(record.status === "suppressed"
            ? { dispatched_at: timestamp }
            : {}),
          created_at: timestamp,
          updated_at: timestamp,
        },
        ...(idempotency ? { idempotency } : {}),
      },
      Math.floor(now.getTime() / 1_000),
    );
    if (!created.replayed) {
      if (record.status === "suppressed") {
        emitCountMetric("SuppressedEmails");
        await this.webhooks.publish("email.suppressed", record, {
          suppressed_recipients: suppressedRecipients.map(
            (suppression) => suppression.email,
          ),
        });
        return { record: created.email, replayed: false };
      }
      try {
        await this.scheduler.schedule(
          record.id,
          scheduledAt,
          now,
          created.outbox.id,
        );
      } catch {
        emitCountMetric("OutboxWakeFailures");
      }
      if (scheduledAt) {
        await this.webhooks.publish("email.scheduled", record);
      }
    } else if (
      created.outbox.dispatched_at === undefined &&
      (created.email.status === "queued" ||
        (created.email.status === "scheduled" &&
          created.email.scheduled_at !== undefined))
    ) {
      try {
        await this.scheduler.schedule(
          created.email.id,
          created.email.scheduled_at,
          now,
          created.outbox.id,
        );
      } catch {
        emitCountMetric("OutboxWakeFailures");
      }
    }
    return { record: created.email, replayed: created.replayed };
  }

  async get(id: string): Promise<EmailRecord> {
    const record = await this.store.getEmail(id);
    if (!record) {
      throw new NotFoundError("Email");
    }
    return record;
  }

  async list(limit: number, cursor?: string): Promise<Page<EmailRecord>> {
    return this.store.listEmails(limit, cursor);
  }

  async listRecipientSummaries(
    id: string,
    limit: number,
    cursor?: string,
    now = new Date(),
  ): Promise<RecipientSummaryPage> {
    const ledger = await this.store.getDeliveryLedger(id);
    if (!ledger) {
      throw new NotFoundError("Delivery ledger");
    }
    const cursorIndex =
      cursor === undefined
        ? -1
        : ledger.recipients.findIndex(
            (recipient) => recipient.id === cursor,
          );
    if (cursor !== undefined && cursorIndex < 0) {
      throw new ValidationError("The pagination cursor is invalid.");
    }
    const attemptById = new Map(
      ledger.attempts.map((attempt) => [attempt.id, attempt]),
    );
    const offset = cursorIndex + 1;
    const recipients = ledger.recipients.slice(offset, offset + limit);
    const data = recipients.map((recipient): RecipientSummary => {
      const attempt = recipient.latest_attempt_id
        ? attemptById.get(recipient.latest_attempt_id)
        : undefined;
      const recovery = recoveryState(recipient, attempt, now);
      return {
        id: recipient.id,
        role: recipient.role,
        ordinal: recipient.ordinal,
        status: recipient.status,
        recovery_state: recovery,
        requires_operator_attention: requiresOperatorAttention(
          recipient,
          recovery,
        ),
        latest_attempt: attempt
          ? {
              id: attempt.id,
              sequence: attempt.sequence,
              status: attempt.status,
              diagnostic_category:
                attempt.diagnostic_category ?? null,
              started_at: attempt.started_at,
              completed_at: attempt.completed_at ?? null,
            }
          : null,
        updated_at: recipient.updated_at,
      };
    });
    const hasMore = offset + data.length < ledger.recipients.length;
    const attemptSummary: RecipientSummaryPage["attempt_summary"] = {
      pending: 0,
      submitting: 0,
      accepted: 0,
      ambiguous: 0,
      retryable_failed: 0,
      permanent_failed: 0,
    };
    for (const attempt of ledger.attempts) {
      attemptSummary[attempt.status] += 1;
    }
    return {
      message_id: id,
      aggregate_status: deriveDeliveryMessageStatus(ledger.recipients),
      recipient_count: ledger.recipients.length,
      attempt_summary: attemptSummary,
      unattributed_event_count: ledger.events.filter(
        (event) => event.recipient_ids.length === 0,
      ).length,
      data,
      has_more: hasMore,
      ...(hasMore && data.length > 0
        ? { next_cursor: data.at(-1)?.id }
        : {}),
    };
  }

  async cancel(id: string): Promise<EmailRecord> {
    const record = await this.get(id);
    if (!["queued", "scheduled"].includes(record.status)) {
      throw new InvalidStateError(
        `Email ${id} cannot be canceled from status ${record.status}.`,
      );
    }
    const updatedAt = new Date().toISOString();
    const ledger = await this.store.getDeliveryLedger(id);
    const ledgerUpdate = ledger
      ? await this.store.applyLocalDeliveryState(
          id,
          "canceled",
          updatedAt,
        )
      : undefined;
    const updated =
      ledgerUpdate?.email ??
      (ledger
        ? undefined
        : await this.store.updateEmail(
            id,
            {
              status: "canceled",
              last_event: "canceled",
              updated_at: updatedAt,
            },
            ["queued", "scheduled"],
          ));
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
    const now = new Date();
    const atomicUpdate = await this.store.rescheduleEmailAndOutbox(
      id,
      parsed,
      now,
    );
    const updated =
      atomicUpdate ??
      (await this.store.updateEmail(
        id,
        {
          scheduled_at: parsed,
          status: "scheduled",
          last_event: "scheduled",
          updated_at: now.toISOString(),
        },
        ["queued", "scheduled"],
      ));
    if (!updated) {
      throw new NotFoundError("Email");
    }
    const outboxId = createOutboxIdentity({
      message_id: id,
      job_type: "dispatch-message",
      generation: 0,
    });
    if (atomicUpdate) {
      try {
        await this.scheduler.reschedule(
          id,
          parsed,
          now,
          outboxId,
        );
      } catch {
        emitCountMetric("OutboxWakeFailures");
      }
    } else {
      await this.scheduler.rescheduleDelivery(id, parsed, now);
    }
    const current = await this.store.getEmail(id);
    if (
      current?.status === "scheduled" &&
      current.scheduled_at &&
      current.scheduled_at !== parsed
    ) {
      if (atomicUpdate) {
        try {
          await this.scheduler.reschedule(
            id,
            current.scheduled_at,
            undefined,
            outboxId,
          );
        } catch {
          emitCountMetric("OutboxWakeFailures");
        }
      } else {
        await this.scheduler.rescheduleDelivery(
          id,
          current.scheduled_at,
        );
      }
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
      await this.scheduler.rescheduleDelivery(id, record.scheduled_at);
      return;
    }

    const suppressedRecipients = await this.suppressions.findSuppressed([
      ...record.to,
      ...(record.cc ?? []),
      ...(record.bcc ?? []),
    ]);
    if (suppressedRecipients.length > 0) {
      const updatedAt = new Date().toISOString();
      const ledger = await this.store.getDeliveryLedger(id);
      const ledgerUpdate = ledger
        ? await this.store.applyLocalDeliveryState(
            id,
            "suppressed",
            updatedAt,
          )
        : undefined;
      const suppressed =
        ledgerUpdate?.email ??
        (ledger
          ? undefined
          : await this.store.updateEmail(
              id,
              {
                status: "suppressed",
                last_event: "suppressed",
                updated_at: updatedAt,
              },
              ["queued", "scheduled"],
            ));
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

    const sending = await this.store.claimEmailForSend(id, attempt, new Date());
    if (!sending) {
      return;
    }

    const ledger = await this.store.getDeliveryLedger(id);
    let deliveryAttempt: DeliveryAttemptRecord | undefined;
    if (ledger) {
      deliveryAttempt = {
        schema_version: "1.0.0",
        record_type: "attempt",
        id: createId("attempt"),
        message_id: id,
        recipient_ids: [...ledger.message.recipient_ids],
        sequence:
          Math.max(
            0,
            ...ledger.attempts.map(
              (existingAttempt) => existingAttempt.sequence,
            ),
          ) + 1,
        provider: ledger.message.provider,
        status: "submitting",
        started_at: sending.updated_at,
      };
      const started = await this.store.beginDeliveryAttempt(deliveryAttempt);
      if (!started) {
        throw new InvalidStateError(
          `Delivery ledger ${id} disappeared while starting an attempt.`,
        );
      }
    }

    let result;
    try {
      const sendable = sending.attachments
        ? {
            ...sending,
            attachments: await Promise.all(
              sending.attachments.map(async (attachment) => ({
                filename: attachment.filename,
                content: bytesToBase64(
                  await this.attachments.read(attachment),
                ),
                ...(attachment.content_type
                  ? { content_type: attachment.content_type }
                  : {}),
                ...(attachment.content_id
                  ? { content_id: attachment.content_id }
                  : {}),
                ...(attachment.content_disposition
                  ? {
                      content_disposition: attachment.content_disposition,
                    }
                  : {}),
              })),
            ),
          }
        : sending;
      result = await this.transport.send(sendable);
    } catch (error) {
      const message = safeFailureMessage("Email delivery failed", error);
      const finalAttempt =
        attempt >= 3 || !shouldRetryOperationalError(error);
      const category = deliveryDiagnosticCategorySchema.catch(
        "application_error",
      ).parse(safeErrorCategory(error));
      const completedAt = new Date().toISOString();
      const ledgerFailure = deliveryAttempt
        ? await this.store.completeDeliveryAttempt({
            message_id: id,
            attempt_id: deliveryAttempt.id,
            status: finalAttempt
              ? "permanent_failed"
              : "retryable_failed",
            completed_at: completedAt,
            diagnostic_category: category,
            public_error: message,
          })
        : undefined;
      const failed =
        ledgerFailure?.email ??
        (deliveryAttempt
          ? undefined
          : await this.store.updateEmail(
              id,
              {
                status: finalAttempt ? "failed" : "queued",
                last_event: finalAttempt ? "failed" : "retrying",
                updated_at: completedAt,
                error: message,
                send_lease_until: undefined,
              },
              ["sending"],
            ));
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
    const completedAt = new Date().toISOString();
    const ledgerSuccess = deliveryAttempt
      ? await this.store.completeDeliveryAttempt({
          message_id: id,
          attempt_id: deliveryAttempt.id,
          status: "accepted",
          completed_at: completedAt,
          provider_message_id: result.provider_id,
        })
      : undefined;
    const sent =
      ledgerSuccess?.email ??
      (deliveryAttempt
        ? undefined
        : await this.store.updateEmail(
            id,
            {
              status: "sent",
              last_event: "sent",
              provider_id: result.provider_id,
              updated_at: completedAt,
              error: undefined,
              send_lease_until: undefined,
            },
            ["sending"],
          ));
    if (sent) {
      await this.webhooks.publish("email.sent", sent);
    }
  }

  async applyProviderEvent(
    id: string,
    type: WebhookEventType,
    input: NormalizedProviderEvent,
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
    const ledger = await this.store.getDeliveryLedger(id);
    if (!ledger) {
      const updated = await this.store.updateEmail(id, {
        status,
        last_event: type.slice("email.".length),
        updated_at: new Date(
          input.received_at ?? Date.now(),
        ).toISOString(),
      });
      if (updated) {
        await this.webhooks.publish(type, updated);
      }
      return;
    }
    if (!input.provider_message_id) {
      throw new InvalidStateError(
        `Provider event for ${id} is missing its provider message ID.`,
      );
    }
    const attempts = ledger.attempts.filter(
      (attempt) =>
        attempt.status === "accepted" &&
        attempt.provider_message_id === input.provider_message_id,
    );
    if (attempts.length !== 1) {
      throw new InvalidStateError(
        `Provider event for ${id} does not correlate to exactly one accepted attempt.`,
      );
    }
    const attempt = attempts[0]!;
    const recipientByAddress = new Map(
      ledger.recipients.map((recipient) => [
        normalizeEnvelopeAddress(recipient.address),
        recipient,
      ]),
    );
    const requestedAddresses = [
      ...new Set(
        (input.recipient_addresses ?? []).map(normalizeEnvelopeAddress),
      ),
    ];
    const correlatedRecipients = requestedAddresses.map((address) =>
      recipientByAddress.get(address),
    );
    if (correlatedRecipients.some((recipient) => recipient === undefined)) {
      throw new InvalidStateError(
        `Provider event for ${id} contains an unknown recipient.`,
      );
    }
    const recipientIds =
      requestedAddresses.length === 0 && ledger.recipients.length === 1
        ? [ledger.recipients[0]!.id]
        : correlatedRecipients.map((recipient) => recipient!.id);
    if (
      recipientIds.some(
        (recipientId) => !attempt.recipient_ids.includes(recipientId),
      )
    ) {
      throw new InvalidStateError(
        `Provider event for ${id} targets a recipient outside its attempt.`,
      );
    }
    const providerAt = new Date(input.provider_at).toISOString();
    const receivedAt = new Date(
      input.received_at ?? Date.now(),
    ).toISOString();
    const providerTypeByEvent: Partial<
      Record<WebhookEventType, ProviderEventRecord["type"]>
    > = {
      "email.delivered": "delivered",
      "email.delivery_delayed": "delayed",
      "email.opened": "opened",
      "email.clicked": "clicked",
      "email.bounced": "bounced",
      "email.complained": "complained",
      "email.failed": "failed",
      "email.suppressed": "failed",
    };
    const providerType = input.provider_type ?? providerTypeByEvent[type];
    if (!providerType) {
      return;
    }
    const digestInput = JSON.stringify({
      provider: ledger.message.provider.name,
      provider_message_id: input.provider_message_id,
      provider_at: providerAt,
      recipient_ids: [...recipientIds].sort(),
      type: providerType,
      terminal: input.terminal ?? false,
      diagnostic_category: input.diagnostic_category,
    });
    const source =
      input.provider_event_id &&
      /^[\x21-\x3F\x41-\x7E]{1,512}$/.test(input.provider_event_id)
        ? {
            kind: "provider_event_id" as const,
            value: input.provider_event_id,
          }
        : {
            kind: "normalized_event_digest" as const,
            value: sha256(digestInput),
          };
    const event: ProviderEventRecord = {
      schema_version: "1.0.0",
      record_type: "provider_event",
      id: createProviderEventIdentity({
        provider: ledger.message.provider.name,
        source,
      }),
      provider: ledger.message.provider,
      source,
      message_id: id,
      attempt_id: attempt.id,
      recipient_ids: recipientIds,
      provider_message_id: input.provider_message_id,
      type: providerType,
      provider_at: providerAt,
      received_at: receivedAt,
      terminal: input.terminal ?? false,
      ...(input.diagnostic_category
        ? { diagnostic_category: input.diagnostic_category }
        : {}),
    };
    const result = await this.store.appendProviderEvent(event);
    const updated = result?.email;
    if (updated) {
      await this.webhooks.publish(type, updated, {
        provider_event_id: event.id,
        provider_message_id: event.provider_message_id,
        provider_at: event.provider_at,
        terminal: event.terminal,
        recipient_ids: event.recipient_ids,
        replayed: result.replayed,
      });
    }
  }
}
