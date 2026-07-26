import {
  deliveryMessageRecordSchema,
  outboxItemRecordSchema,
  recipientRecordSchema,
  type DeliveryMessageRecord,
  type OutboxItemRecord,
  type RecipientRecord,
} from "./delivery-model.js";
import type { EmailRecord, IdempotencyClaim } from "./types.js";

export interface DeliveryCommit {
  email: EmailRecord;
  message: DeliveryMessageRecord;
  recipients: RecipientRecord[];
  outbox: OutboxItemRecord;
  idempotency?: IdempotencyClaim | undefined;
}

export function validateDeliveryCommit(
  input: DeliveryCommit,
  nowEpochSeconds: number,
): DeliveryCommit {
  if (!Number.isInteger(nowEpochSeconds) || nowEpochSeconds < 0) {
    throw new Error("Atomic delivery commit requires a valid current time.");
  }
  const email = structuredClone(input.email);
  const message = deliveryMessageRecordSchema.parse(input.message);
  const recipients = input.recipients.map((recipient) =>
    recipientRecordSchema.parse(recipient),
  );
  const outbox = outboxItemRecordSchema.parse(input.outbox);
  if (!["queued", "scheduled"].includes(email.status)) {
    throw new Error("Atomic delivery commit requires a dispatchable email.");
  }
  if (
    email.id !== message.id ||
    email.request_hash !== message.intent_digest ||
    email.created_at !== message.created_at ||
    email.updated_at !== message.updated_at ||
    email.status !== message.status ||
    email.scheduled_at !== message.scheduled_at
  ) {
    throw new Error(
      "Legacy email and provider-neutral message records do not match.",
    );
  }
  if (
    input.idempotency &&
    (input.idempotency.request_hash !== email.request_hash ||
      input.idempotency.expires_at <= nowEpochSeconds)
  ) {
    throw new Error("Idempotency claim does not match the delivery intent.");
  }
  const recipientIds = recipients.map((recipient) => recipient.id);
  if (
    recipients.length === 0 ||
    new Set(recipientIds).size !== recipients.length ||
    message.recipient_ids.length !== recipients.length ||
    !message.recipient_ids.every((id) => recipientIds.includes(id)) ||
    recipients.some(
      (recipient) =>
        recipient.message_id !== message.id ||
        recipient.status !== "queued" ||
        recipient.latest_attempt_id !== undefined ||
        recipient.created_at !== message.created_at ||
        recipient.updated_at !== message.updated_at,
    )
  ) {
    throw new Error("Recipient records do not match the delivery message.");
  }
  const recipientAddresses = recipients.map((recipient) =>
    recipient.address.toLowerCase(),
  );
  const recipientPositions = recipients.map(
    (recipient) => `${recipient.role}:${recipient.ordinal}`,
  );
  if (
    new Set(recipientAddresses).size !== recipientAddresses.length ||
    new Set(recipientPositions).size !== recipientPositions.length
  ) {
    throw new Error(
      "Delivery recipients must have unique addresses and envelope positions.",
    );
  }
  const expectedDueAt = email.scheduled_at ?? email.created_at;
  if (
    outbox.message_id !== message.id ||
    outbox.job_type !== "dispatch-message" ||
    outbox.generation !== 0 ||
    outbox.due_at !== expectedDueAt ||
    outbox.attempts !== 0 ||
    outbox.lease_owner !== undefined ||
    outbox.lease_expires_at !== undefined ||
    outbox.dispatched_at !== undefined ||
    outbox.last_diagnostic_category !== undefined ||
    outbox.created_at !== message.created_at ||
    outbox.updated_at !== message.updated_at
  ) {
    throw new Error("Outbox item does not match the delivery intent.");
  }
  return {
    email,
    message,
    recipients,
    outbox,
    ...(input.idempotency
      ? { idempotency: structuredClone(input.idempotency) }
      : {}),
  };
}
