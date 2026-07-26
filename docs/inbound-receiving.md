# Inbound receiving

HayaSend can provision an opt-in Amazon SES Mail Manager ingress endpoint,
store each message in a dedicated KMS-encrypted S3 bucket, and expose
Resend-shaped receiving webhooks and retrieval APIs.

Inbound receiving is disabled by default. Enabling the resources alone does
not change DNS, so no production mail flow changes until an operator publishes
an MX record.

## Enable the receiving stack

Deploy in a Region that supports SES email receiving:

```bash
sam build
sam deploy \
  --parameter-overrides \
    EnableInbound=true \
    InboundRecipientSuffixes=@inbound.example.com \
    InboundRetentionDays=7 \
    InboundMaxMessageSizeBytes=26214400 \
    InboundTlsPolicy=OPTIONAL
```

`InboundRecipientSuffixes` is mandatory in practice: its safe default,
`@example.invalid`, rejects mail for real domains. Supply one to ten
comma-separated envelope-recipient suffixes, each with the leading `@`.
Using a dedicated receiving subdomain sharply limits accidental and abusive
processing of unrelated recipients.

`OPTIONAL` accepts senders that cannot negotiate STARTTLS and gives the
broadest internet deliverability. Use `REQUIRED` only when every upstream
server is known to support STARTTLS. The ingress is public (`OPEN`), so use a
dedicated receiving subdomain and monitor cost and abuse before moving
important traffic.

Read the generated target:

```bash
export HAYASEND_INBOUND_MX="$(
  aws cloudformation describe-stacks \
    --stack-name hayasend \
    --query 'Stacks[0].Outputs[?OutputKey==`InboundMxRecord`].OutputValue' \
    --output text
)"
printf '%s\n' "$HAYASEND_INBOUND_MX"
```

Before publishing DNS, confirm the intended domain matches one of
`InboundRecipientSuffixes`, then create and verify an `email.received`
webhook. Add an MX record with priority `10` whose value is
`InboundMxRecord`. Prefer a subdomain such as `inbound.example.com`; replacing
the lowest-priority MX on a root domain can interrupt an existing mailbox
provider.

## Receive an event

The webhook contains routing metadata but no body or attachment bytes:

```json
{
  "type": "email.received",
  "created_at": "2026-07-26T08:00:01.000Z",
  "data": {
    "email_id": "recv_0123456789abcdef0123456789abcdef",
    "created_at": "2026-07-26T08:00:00.000Z",
    "from": "Customer <customer@example.net>",
    "to": ["support@inbound.example.com"],
    "received_for": ["support@inbound.example.com"],
    "bcc": [],
    "cc": [],
    "message_id": "<thread-42@example.net>",
    "subject": "Help",
    "attachments": []
  }
}
```

Use an API key with `emails:read` to retrieve structured content:

```bash
curl "$HAYASEND_BASE_URL/emails/receiving/$EMAIL_ID" \
  -H "Authorization: Bearer $HAYASEND_API_KEY"
```

The response includes `html`, `html_format`, `text`, normalized lower-case
`headers`, and a 15-minute `raw.download_url`. The default
`html_format=data_uri` embeds referenced inline attachments up to a bounded
aggregate size; larger or unresolved inline content safely falls back to
`cid`. Pass `html_format=cid` to always preserve the original references. List
attachments at
`GET /emails/receiving/{email_id}/attachments`, then retrieve a 15-minute
download URL from
`GET /emails/receiving/{email_id}/attachments/{attachment_id}`.

Webhook consumers must treat delivery as at least once and deduplicate on
`data.email_id`. HayaSend derives that ID deterministically from the SES
message ID and uses a DynamoDB lease to collapse concurrent Mail Manager
invocations.

## Forward explicitly with the official SDK

The official Node SDK can forward a retained message without a HayaSend-only
API:

```ts
await resend.emails.receiving.forward(
  {
    emailId,
    from: "Forwarder <forwarder@verified.example.com>",
    to: "archive@example.net",
  },
  { idempotencyKey: `forward-${emailId}` },
);
```

The API key needs `emails:read` to retrieve the message and `emails:send` to
submit the forwarded copy. The helper downloads the 15-minute raw MIME URL,
parses it on the caller, and sends the content and attachments through the
normal email API. Use a verified SES identity for `from`; using the original,
untrusted sender would fail identity policy and can break DMARC. A stable
idempotency key prevents duplicate forwarded sends when a webhook consumer
retries.

## Storage and failure behavior

Mail Manager executes these actions in order for matching recipients:

1. write the complete MIME message under `inbound/raw/`;
2. invoke the parser Lambda asynchronously;
3. parse bounded headers and MIME nesting;
4. store structured bodies and extracted attachments;
5. write receiving metadata and queue the webhook event.

Both Mail Manager actions use `DROP` on configuration failure, preventing an
event from claiming that a message was stored when S3 persistence failed.
Lambda retries processing twice and sends exhausted events to the dedicated
inbound DLQ. Raw messages, parsed content, attachment objects, DynamoDB
metadata, and deduplication claims share the configured 1–30 day retention.

The bucket uses a customer-managed KMS key, versioning, bucket keys, public
access blocking, and an explicit denial of plaintext transport. CloudFormation
retains the bucket and KMS key when deleting the stack to avoid irreversible
mail loss. Operators must deliberately empty and delete retained data when
decommissioning.

Structured HTML is returned as data and is never rendered by HayaSend.
Applications that render inbound HTML must sanitize it. Extremely large body
fields are bounded to keep responses below API Gateway limits; when
`content_truncated` is true, use the raw MIME download.

## Current boundary

This foundation is catch-all at the Mail Manager ingress. Explicit SDK-assisted
forwarding is supported, but automatic alias routing, loop detection, and
ARC-aware forwarding policy remain v0.2 work. The proposed
[inbound alias routing design](inbound-routing-design.md) defines the ownership,
destination verification, message transformation, authentication, loop,
failure, privacy, and staged approval boundaries. It is documentation only;
no automatic route exists yet. Do not point a production mailbox domain at
HayaSend until those behaviors are implemented and match the intended mail
flow.

AWS references:

- [Create a Mail Manager ingress endpoint](https://docs.aws.amazon.com/ses/latest/dg/eb-ingress.html)
- [Mail Manager rules and ordered actions](https://docs.aws.amazon.com/ses/latest/dg/eb-rules.html)
- [Mail Manager traffic-policy recipient matching](https://docs.aws.amazon.com/ses/latest/dg/eb-filters.html)
- [Mail Manager rule-action IAM policies](https://docs.aws.amazon.com/ses/latest/dg/eb-policies.html)
- [SES receiving payload and S3 object-key contract](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html)
- [SES regional receiving endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html)
