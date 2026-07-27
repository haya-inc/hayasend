#!/usr/bin/env node

import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const tableName = required("HAYASEND_TABLE_NAME");
const emailId = required("HAYASEND_EMAIL_ID");
if (!/^email_[a-f0-9]{32}$/.test(emailId)) {
  throw new Error("HAYASEND_EMAIL_ID is invalid.");
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const deadline = Date.now() + 60_000;
let baseItems = [];
let eventItems = [];

while (Date.now() < deadline) {
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
  baseItems = base.Items ?? [];
  eventItems = events.Items ?? [];
  if (
    baseItems.some((item) => item.entity?.record_type === "attempt") &&
    eventItems.some(
      (item) =>
        item.entity?.record_type === "provider_event" &&
        item.entity.type === "delivered" &&
        item.entity.terminal === true,
    )
  ) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

const entities = baseItems.map((item) => item.entity).filter(Boolean);
const email = entities.find((entity) => entity.id === emailId && entity.from);
const messages = entities.filter(
  (entity) => entity.record_type === "message",
);
const recipients = entities.filter(
  (entity) => entity.record_type === "recipient",
);
const attempts = entities.filter(
  (entity) => entity.record_type === "attempt",
);
const events = eventItems
  .map((item) => item.entity)
  .filter((entity) => entity?.record_type === "provider_event");
const terminalEvents = events.filter((event) => event.terminal === true);
const deliveredEvents = terminalEvents.filter(
  (event) => event.type === "delivered",
);

if (
  !email ||
  messages.length !== 1 ||
  recipients.length !== 1 ||
  attempts.length !== 1 ||
  terminalEvents.length !== 1 ||
  deliveredEvents.length !== 1
) {
  throw new Error(
    "Expected one email, message, recipient, accepted attempt, and terminal delivered provider event.",
  );
}

const message = messages[0];
const recipient = recipients[0];
const attempt = attempts[0];
const event = deliveredEvents[0];
const providerMessageId = attempt.provider_message_id;
if (
  email.status !== "delivered" ||
  email.provider_id !== providerMessageId ||
  message.status !== "delivered" ||
  recipient.status !== "delivered" ||
  attempt.status !== "accepted" ||
  !providerMessageId ||
  event.provider_message_id !== providerMessageId ||
  event.message_id !== emailId ||
  event.attempt_id !== attempt.id ||
  event.recipient_ids?.length !== 1 ||
  event.recipient_ids[0] !== recipient.id ||
  attempt.recipient_ids?.length !== 1 ||
  attempt.recipient_ids[0] !== recipient.id
) {
  throw new Error(
    "The SES provider ID, accepted attempt, delivery event, and recipient ledger did not converge.",
  );
}

const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");
console.log(
  JSON.stringify({
    object: "aws_ses_terminal_ledger_proof",
    email_id: emailId,
    email_status: email.status,
    message_status: message.status,
    recipient_status: recipient.status,
    attempt_status: attempt.status,
    attempt_count: attempts.length,
    terminal_event_count: terminalEvents.length,
    delivered_event_count: deliveredEvents.length,
    provider_message_id_sha256: digest(providerMessageId),
    provider_event_id_sha256: digest(event.id),
    provider_id_correlated: true,
    exact_recipient_correlated: true,
    terminal: true,
  }),
);
