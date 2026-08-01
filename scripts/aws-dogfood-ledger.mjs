#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { durationSummary } from "./aws-dogfood-plan.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const tableName = required("HAYASEND_TABLE_NAME");
const deliveryFile = required("HAYASEND_DOGFOOD_DELIVERY_FILE");
const delivery = JSON.parse(await readFile(deliveryFile, "utf8"));
if (
  delivery.object !== "aws_ses_dogfood_delivery_proof" ||
  delivery.terminal !== true ||
  delivery.scoped_api_key_revoked !== true ||
  !Array.isArray(delivery.email_ids) ||
  delivery.email_ids.length !== delivery.campaign?.batch_size
) {
  throw new Error("The dogfood delivery proof is incomplete.");
}
if (
  delivery.email_ids.some((emailId) => !/^email_[a-f0-9]{32}$/.test(emailId)) ||
  new Set(delivery.email_ids).size !== delivery.email_ids.length
) {
  throw new Error(
    "The dogfood delivery proof contains invalid or duplicate IDs.",
  );
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const elapsed = (later, earlier) => {
  const value = Date.parse(later) - Date.parse(earlier);
  if (!Number.isFinite(value)) {
    throw new Error("The delivery ledger contains an invalid timestamp.");
  }
  return Math.max(0, value);
};

async function loadLedger(emailId) {
  const [base, events] = await Promise.all([
    client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :partition",
        ExpressionAttributeValues: {
          ":partition": `EMAIL#${emailId}`,
        },
        ConsistentRead: true,
      }),
    ),
    client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :partition",
        ExpressionAttributeValues: {
          ":partition": `DELIVERY_EVENTS#${emailId}`,
        },
      }),
    ),
  ]);
  const entities = (base.Items ?? [])
    .map((item) => item.entity)
    .filter(Boolean);
  return {
    email: entities.find((entity) => entity.id === emailId && entity.from),
    message: entities.find((entity) => entity.record_type === "message"),
    recipients: entities.filter((entity) => entity.record_type === "recipient"),
    attempts: entities.filter((entity) => entity.record_type === "attempt"),
    events: (events.Items ?? [])
      .map((item) => item.entity)
      .filter((entity) => entity?.record_type === "provider_event"),
  };
}

function correlate(emailId, ledger) {
  const acceptedAttempts = ledger.attempts.filter(
    (attempt) => attempt.status === "accepted",
  );
  const terminalEvents = ledger.events.filter(
    (event) => event.terminal === true,
  );
  const deliveredEvents = terminalEvents.filter(
    (event) => event.type === "delivered",
  );
  if (
    !ledger.email ||
    !ledger.message ||
    ledger.recipients.length !== 1 ||
    acceptedAttempts.length !== 1 ||
    terminalEvents.length !== 1 ||
    deliveredEvents.length !== 1
  ) {
    return undefined;
  }
  const recipient = ledger.recipients[0];
  const attempt = acceptedAttempts[0];
  const event = deliveredEvents[0];
  const providerMessageId = attempt.provider_message_id;
  if (
    ledger.email.status !== "delivered" ||
    ledger.email.provider_id !== providerMessageId ||
    ledger.message.status !== "delivered" ||
    recipient.status !== "delivered" ||
    recipient.latest_attempt_id !== attempt.id ||
    !providerMessageId ||
    event.provider_message_id !== providerMessageId ||
    event.message_id !== emailId ||
    event.attempt_id !== attempt.id ||
    event.recipient_ids?.length !== 1 ||
    event.recipient_ids[0] !== recipient.id ||
    attempt.recipient_ids?.length !== 1 ||
    attempt.recipient_ids[0] !== recipient.id ||
    !attempt.completed_at
  ) {
    return undefined;
  }
  return {
    email_id_sha256: digest(emailId),
    provider_message_id_sha256: digest(providerMessageId),
    attempt_count: ledger.attempts.length,
    retryable_failure_count: ledger.attempts.filter(
      (item) => item.status === "retryable_failed",
    ).length,
    terminal_event_count: terminalEvents.length,
    queue_to_provider_ms: elapsed(
      attempt.completed_at,
      ledger.email.created_at,
    ),
    provider_terminal_ms: elapsed(event.provider_at, attempt.completed_at),
    provider_event_ingest_ms: elapsed(event.received_at, event.provider_at),
    end_to_end_ms: elapsed(recipient.updated_at, ledger.email.created_at),
  };
}

const deadline = Date.now() + 180_000;
const correlated = new Map();
while (Date.now() < deadline && correlated.size < delivery.email_ids.length) {
  for (const emailId of delivery.email_ids) {
    if (correlated.has(emailId)) {
      continue;
    }
    const evidence = correlate(emailId, await loadLedger(emailId));
    if (evidence) {
      correlated.set(emailId, evidence);
    }
  }
  if (correlated.size < delivery.email_ids.length) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
if (correlated.size !== delivery.email_ids.length) {
  throw new Error(
    `${delivery.email_ids.length - correlated.size} dogfood delivery ledgers did not converge.`,
  );
}

const entries = delivery.email_ids.map((emailId) => correlated.get(emailId));
const totalAttempts = entries.reduce(
  (total, entry) => total + entry.attempt_count,
  0,
);
const retryableFailures = entries.reduce(
  (total, entry) => total + entry.retryable_failure_count,
  0,
);
console.log(
  JSON.stringify({
    object: "aws_ses_dogfood_ledger_proof",
    campaign: delivery.campaign,
    notification_counts: delivery.notification_counts,
    submitted: delivery.submitted,
    delivered: entries.length,
    unexplained_loss: 0,
    duplicate_email_ids: 0,
    duplicate_terminal_events: 0,
    total_attempts: totalAttempts,
    retryable_failures: retryableFailures,
    email_id_sha256: entries.map((entry) => entry.email_id_sha256),
    provider_message_id_sha256: entries.map(
      (entry) => entry.provider_message_id_sha256,
    ),
    latency: {
      queue_to_provider: durationSummary(
        entries.map((entry) => entry.queue_to_provider_ms),
      ),
      provider_terminal: durationSummary(
        entries.map((entry) => entry.provider_terminal_ms),
      ),
      provider_event_ingest: durationSummary(
        entries.map((entry) => entry.provider_event_ingest_ms),
      ),
      end_to_end: durationSummary(entries.map((entry) => entry.end_to_end_ms)),
    },
    provider_id_correlated: true,
    exact_recipient_correlated: true,
    terminal: true,
  }),
);
