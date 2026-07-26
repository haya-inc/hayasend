import {
  deliveryAttemptRecordSchema,
  deliveryDiagnosticCategorySchema,
  deliveryMessageRecordSchema,
  providerEventRecordSchema,
  recipientRecordSchema,
  type DeliveryAttemptRecord,
  type DeliveryDiagnosticCategory,
  type DeliveryMessageRecord,
  type ProviderEventRecord,
  type RecipientRecord,
} from "./delivery-model.js";
import type { EmailRecord, EmailStatus } from "./types.js";

export interface DeliveryLedgerState {
  email: EmailRecord;
  message: DeliveryMessageRecord;
  recipients: RecipientRecord[];
  attempts: DeliveryAttemptRecord[];
}

export interface DeliveryLedgerPlan extends DeliveryLedgerState {
  changed_recipient_ids: string[];
}

export interface AttemptCompletion {
  message_id: string;
  attempt_id: string;
  status: "accepted" | "retryable_failed" | "permanent_failed";
  completed_at: string;
  provider_message_id?: string | undefined;
  diagnostic_category?: DeliveryDiagnosticCategory | undefined;
  public_error?: string | undefined;
}

const DELIVERY_POSITIVE = new Set<RecipientRecord["status"]>([
  "delivered",
  "opened",
  "clicked",
]);

const DELIVERY_NEGATIVE = new Set<RecipientRecord["status"]>([
  "bounced",
  "rejected",
  "failed",
]);

const ENGAGEMENT_RANK: Partial<Record<RecipientRecord["status"], number>> = {
  queued: 0,
  sending: 1,
  accepted: 2,
  delivery_delayed: 3,
  delivered: 4,
  opened: 5,
  clicked: 6,
};

const EVENT_TARGET: Record<
  ProviderEventRecord["type"],
  RecipientRecord["status"]
> = {
  accepted: "accepted",
  delivered: "delivered",
  delayed: "delivery_delayed",
  bounced: "bounced",
  complained: "complained",
  rejected: "rejected",
  opened: "opened",
  clicked: "clicked",
  failed: "failed",
};

function assertLedgerState(state: DeliveryLedgerState): DeliveryLedgerState {
  const message = deliveryMessageRecordSchema.parse(state.message);
  const recipients = state.recipients.map((recipient) =>
    recipientRecordSchema.parse(recipient),
  );
  const attempts = state.attempts.map((attempt) =>
    deliveryAttemptRecordSchema.parse(attempt),
  );
  const recipientIds = new Set(recipients.map((recipient) => recipient.id));
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const attemptSequences = new Set(
    attempts.map((attempt) => attempt.sequence),
  );
  if (
    state.email.id !== message.id ||
    recipients.length !== message.recipient_ids.length ||
    !message.recipient_ids.every((id) => recipientIds.has(id)) ||
    recipients.some((recipient) => recipient.message_id !== message.id) ||
    attemptIds.size !== attempts.length ||
    attemptSequences.size !== attempts.length ||
    attempts.some(
      (attempt) =>
        attempt.message_id !== message.id ||
        JSON.stringify(attempt.provider) !==
          JSON.stringify(message.provider) ||
        attempt.recipient_ids.some((id) => !recipientIds.has(id)),
    )
  ) {
    throw new Error("Delivery ledger records do not belong to one message.");
  }
  const recipientById = new Map(
    recipients.map((recipient) => [recipient.id, recipient]),
  );
  return {
    email: structuredClone(state.email),
    message,
    recipients: message.recipient_ids.map((id) =>
      structuredClone(recipientById.get(id)!),
    ),
    attempts,
  };
}

function updateEmailForRecipients(
  email: EmailRecord,
  message: DeliveryMessageRecord,
  recipients: RecipientRecord[],
  updatedAt: string,
  publicError?: string,
): EmailRecord {
  const status = derivePublicEmailStatus(message.status, recipients);
  return {
    ...email,
    status,
    last_event: status,
    updated_at: updatedAt,
    send_lease_until: undefined,
    ...(publicError === undefined
      ? { error: undefined }
      : { error: publicError }),
  };
}

function updateMessage(
  message: DeliveryMessageRecord,
  recipients: RecipientRecord[],
  updatedAt: string,
): DeliveryMessageRecord {
  return deliveryMessageRecordSchema.parse({
    ...message,
    status: deriveDeliveryMessageStatus(recipients),
    updated_at: updatedAt,
  });
}

function latestTimestamp(...values: string[]): string {
  return new Date(
    Math.max(...values.map((value) => Date.parse(value))),
  ).toISOString();
}

export function transitionRecipientStatus(
  current: RecipientRecord["status"],
  eventType: ProviderEventRecord["type"],
): RecipientRecord["status"] {
  const target = EVENT_TARGET[eventType];
  if (current === "suppressed") {
    return current;
  }
  if (eventType === "complained") {
    return "complained";
  }
  if (current === "complained" || current === "canceled") {
    return current;
  }
  if (eventType === "bounced") {
    return "bounced";
  }
  if (current === "bounced") {
    return current;
  }
  if (eventType === "rejected") {
    return ["delivered", "opened", "clicked"].includes(current)
      ? current
      : "rejected";
  }
  if (current === "rejected") {
    return current;
  }
  if (eventType === "failed") {
    return ["delivered", "opened", "clicked"].includes(current)
      ? current
      : "failed";
  }
  if (current === "failed") {
    return current;
  }
  const currentRank = ENGAGEMENT_RANK[current];
  const targetRank = ENGAGEMENT_RANK[target];
  if (currentRank === undefined || targetRank === undefined) {
    return current;
  }
  return targetRank > currentRank ? target : current;
}

export function deriveDeliveryMessageStatus(
  recipients: readonly RecipientRecord[],
): DeliveryMessageRecord["status"] {
  if (recipients.length === 0) {
    throw new Error("A delivery message requires at least one recipient.");
  }
  const statuses = recipients.map((recipient) => recipient.status);
  if (statuses.includes("suppressed")) {
    return "suppressed";
  }
  if (statuses.includes("complained")) {
    return "complained";
  }
  const positiveCount = statuses.filter((status) =>
    DELIVERY_POSITIVE.has(status),
  ).length;
  if (positiveCount > 0) {
    return positiveCount === statuses.length
      ? "delivered"
      : "partially_delivered";
  }
  if (statuses.includes("bounced")) {
    return "bounced";
  }
  if (statuses.some((status) => DELIVERY_NEGATIVE.has(status))) {
    return "failed";
  }
  if (statuses.every((status) => status === "canceled")) {
    return "canceled";
  }
  if (statuses.includes("delivery_delayed")) {
    return "delivery_delayed";
  }
  if (statuses.includes("accepted")) {
    return "accepted";
  }
  if (statuses.includes("sending")) {
    return "sending";
  }
  return "queued";
}

export function derivePublicEmailStatus(
  aggregate: DeliveryMessageRecord["status"],
  recipients: readonly RecipientRecord[],
): EmailStatus {
  if (aggregate === "accepted") {
    return "sent";
  }
  if (aggregate === "partially_delivered") {
    if (recipients.some((recipient) => recipient.status === "bounced")) {
      return "bounced";
    }
    if (
      recipients.some((recipient) =>
        ["rejected", "failed"].includes(recipient.status),
      )
    ) {
      return "failed";
    }
    return "delivered";
  }
  if (aggregate === "delivered") {
    if (recipients.some((recipient) => recipient.status === "clicked")) {
      return "clicked";
    }
    if (recipients.some((recipient) => recipient.status === "opened")) {
      return "opened";
    }
    return "delivered";
  }
  return aggregate;
}

export function planAttemptStart(
  inputState: DeliveryLedgerState,
  inputAttempt: DeliveryAttemptRecord,
): DeliveryLedgerPlan & { attempt: DeliveryAttemptRecord } {
  const state = assertLedgerState(inputState);
  const attempt = deliveryAttemptRecordSchema.parse(inputAttempt);
  if (
    attempt.message_id !== state.message.id ||
    JSON.stringify(attempt.provider) !==
      JSON.stringify(state.message.provider) ||
    attempt.status !== "submitting" ||
    attempt.completed_at !== undefined ||
    attempt.recipient_ids.length !== state.message.recipient_ids.length ||
    !state.message.recipient_ids.every((id) =>
      attempt.recipient_ids.includes(id),
    ) ||
    state.attempts.some(
      (existing) =>
        existing.id === attempt.id || existing.sequence === attempt.sequence,
    ) ||
    attempt.sequence !==
      Math.max(0, ...state.attempts.map((existing) => existing.sequence)) + 1
  ) {
    throw new Error("Provider submission attempt does not match the ledger.");
  }
  if (
    state.recipients.some((recipient) => recipient.status !== "queued")
  ) {
    throw new Error("Only queued recipients can begin another attempt.");
  }
  const recipients = state.recipients.map((recipient) =>
    recipientRecordSchema.parse({
      ...recipient,
      status: "sending",
      latest_attempt_id: attempt.id,
      updated_at: attempt.started_at,
    }),
  );
  const message = updateMessage(state.message, recipients, attempt.started_at);
  return {
    email: {
      ...state.email,
      status: "sending",
      last_event: "sending",
      updated_at: attempt.started_at,
    },
    message,
    recipients,
    attempts: [...state.attempts, attempt],
    attempt,
    changed_recipient_ids: recipients.map((recipient) => recipient.id),
  };
}

export function planAttemptCompletion(
  inputState: DeliveryLedgerState,
  input: AttemptCompletion,
): DeliveryLedgerPlan & { attempt: DeliveryAttemptRecord } {
  const state = assertLedgerState(inputState);
  const attemptIndex = state.attempts.findIndex(
    (attempt) =>
      attempt.id === input.attempt_id &&
      attempt.message_id === input.message_id,
  );
  const currentAttempt = state.attempts[attemptIndex];
  if (!currentAttempt || currentAttempt.status !== "submitting") {
    throw new Error("Provider submission attempt is not active.");
  }
  if (
    state.recipients
      .filter((recipient) =>
        currentAttempt.recipient_ids.includes(recipient.id),
      )
      .some(
        (recipient) =>
          recipient.status !== "sending" ||
          recipient.latest_attempt_id !== currentAttempt.id,
      )
  ) {
    throw new Error(
      "Provider submission attempt does not own every sending recipient.",
    );
  }
  const completedAt = new Date(input.completed_at).toISOString();
  const diagnosticCategory =
    input.diagnostic_category === undefined
      ? undefined
      : deliveryDiagnosticCategorySchema.parse(input.diagnostic_category);
  const attempt = deliveryAttemptRecordSchema.parse({
    ...currentAttempt,
    status: input.status,
    completed_at: completedAt,
    ...(input.provider_message_id
      ? { provider_message_id: input.provider_message_id }
      : {}),
    ...(diagnosticCategory
      ? { diagnostic_category: diagnosticCategory }
      : {}),
  });
  const failureStatus: RecipientRecord["status"] =
    diagnosticCategory === "provider_rejected" ||
    diagnosticCategory === "invalid_data"
      ? "rejected"
      : "failed";
  const recipientStatus: RecipientRecord["status"] =
    input.status === "accepted"
      ? "accepted"
      : input.status === "retryable_failed"
        ? "queued"
        : failureStatus;
  const changedRecipientIds: string[] = [];
  const recipients = state.recipients.map((recipient) => {
    if (
      !currentAttempt.recipient_ids.includes(recipient.id) ||
      recipient.latest_attempt_id !== currentAttempt.id
    ) {
      return recipient;
    }
    changedRecipientIds.push(recipient.id);
    return recipientRecordSchema.parse({
      ...recipient,
      status: recipientStatus,
      updated_at: completedAt,
    });
  });
  const message = updateMessage(state.message, recipients, completedAt);
  const email = updateEmailForRecipients(
    state.email,
    message,
    recipients,
    completedAt,
    input.status === "accepted" ? undefined : input.public_error,
  );
  if (input.status === "accepted" && input.provider_message_id) {
    email.provider_id = input.provider_message_id;
  } else if (input.status === "retryable_failed") {
    email.last_event = "retrying";
  }
  const attempts = [...state.attempts];
  attempts[attemptIndex] = attempt;
  return {
    email,
    message,
    recipients,
    attempts,
    attempt,
    changed_recipient_ids: changedRecipientIds,
  };
}

export function planProviderEvent(
  inputState: DeliveryLedgerState,
  inputEvent: ProviderEventRecord,
): DeliveryLedgerPlan & { event: ProviderEventRecord } {
  const state = assertLedgerState(inputState);
  const event = providerEventRecordSchema.parse(inputEvent);
  const attempt = state.attempts.find(
    (candidate) => candidate.id === event.attempt_id,
  );
  const providerMatches =
    event.provider_message_id === undefined
      ? []
      : state.attempts.filter(
          (candidate) =>
            candidate.status === "accepted" &&
            candidate.provider_message_id === event.provider_message_id,
        );
  const recipientIds = new Set(state.recipients.map((recipient) => recipient.id));
  if (
    event.message_id !== state.message.id ||
    JSON.stringify(event.provider) !==
      JSON.stringify(state.message.provider) ||
    !attempt ||
    attempt.status !== "accepted" ||
    JSON.stringify(attempt.provider) !== JSON.stringify(event.provider) ||
    (event.provider_message_id !== undefined &&
      (providerMatches.length !== 1 ||
        providerMatches[0]?.id !== attempt.id)) ||
    (event.provider_message_id !== undefined &&
      event.provider_message_id !== attempt.provider_message_id) ||
    event.recipient_ids.some(
      (id) => !recipientIds.has(id) || !attempt.recipient_ids.includes(id),
    )
  ) {
    throw new Error("Provider event cannot be correlated to one accepted attempt.");
  }
  const mutationTimestamp = latestTimestamp(
    state.email.updated_at,
    state.message.updated_at,
    event.received_at,
  );
  const targetIds = new Set(event.recipient_ids);
  const changedRecipientIds: string[] = [];
  const recipients = state.recipients.map((recipient) => {
    if (!targetIds.has(recipient.id)) {
      return recipient;
    }
    const status = transitionRecipientStatus(recipient.status, event.type);
    if (status === recipient.status) {
      return recipient;
    }
    changedRecipientIds.push(recipient.id);
    return recipientRecordSchema.parse({
      ...recipient,
      status,
      updated_at: mutationTimestamp,
    });
  });
  const message = updateMessage(
    state.message,
    recipients,
    mutationTimestamp,
  );
  return {
    email: updateEmailForRecipients(
      state.email,
      message,
      recipients,
      mutationTimestamp,
    ),
    message,
    recipients,
    attempts: state.attempts,
    event,
    changed_recipient_ids: changedRecipientIds,
  };
}

export function planLocalRecipientState(
  inputState: DeliveryLedgerState,
  status: "canceled" | "suppressed",
  updatedAt: string,
): DeliveryLedgerPlan {
  const state = assertLedgerState(inputState);
  if (
    state.attempts.some((attempt) => attempt.status === "submitting") ||
    state.recipients.some((recipient) => recipient.status === "sending")
  ) {
    throw new Error(
      "Local recipient state cannot change during provider submission.",
    );
  }
  const timestamp = latestTimestamp(
    state.email.updated_at,
    state.message.updated_at,
    new Date(updatedAt).toISOString(),
  );
  const changedRecipientIds: string[] = [];
  const recipients = state.recipients.map((recipient) => {
    if (
      ["complained", "suppressed"].includes(recipient.status) ||
      recipient.status === status
    ) {
      return recipient;
    }
    changedRecipientIds.push(recipient.id);
    return recipientRecordSchema.parse({
      ...recipient,
      status,
      updated_at: timestamp,
    });
  });
  const message = updateMessage(state.message, recipients, timestamp);
  return {
    email: updateEmailForRecipients(
      state.email,
      message,
      recipients,
      timestamp,
    ),
    message,
    recipients,
    attempts: state.attempts,
    changed_recipient_ids: changedRecipientIds,
  };
}
