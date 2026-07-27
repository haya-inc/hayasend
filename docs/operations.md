# Operations runbook

This runbook is the minimum operating procedure for an AWS deployment.
For disposable end-to-end validation, use the
[dedicated-account integration workflow](aws-integration-testing.md).
Budget the selected Region and retention policy with the
[AWS cost model](aws-costs.md), then replace its assumptions with observed
Cost Explorer and CloudWatch usage after deployment.

## Deployment principal

The plan-first CLI needs read access for:

- `sts:GetCallerIdentity`;
- `ses:GetAccount`;
- `cloudformation:DescribeStacks`.

`--apply` additionally reads CloudFormation change sets and failure events
through `cloudformation:ListChangeSets`,
`cloudformation:DescribeChangeSet`, and
`cloudformation:DescribeStackEvents`. It uses ordinary SAM deployment
operations, including artifact-bucket access and CloudFormation change-set
creation/execution. The deployment principal must be authorized for every
resource type in `template.yaml`; `CAPABILITY_IAM` is always explicit.
HayaSend does not ship a broad administrator policy disguised as a
least-privilege policy. Derive the deployment role from the checked-in
template, organizational permission boundaries, Region, and enabled inbound
features, then review it through the same infrastructure process as other
production roles.

The CLI never reads the bootstrap secret value, edits DNS, or passes
credentials as command-line arguments. Its JSON output contains account IDs,
principal and resource ARNs, domain suffixes, and stack outputs, so retain it
as operational metadata rather than posting it publicly.

## After deployment

1. Subscribe the on-call destination to the `AlarmTopicArn` stack output and
   confirm the SNS subscription.
2. Open the generated CloudWatch dashboard.
3. Create a scoped application key with the bootstrap administrator key using
   the secret-safe [`hayasend keys create`](cli.md#manage-least-privilege-api-keys)
   workflow.
4. Store the application token in the workload's secret manager.
5. Complete [sending-domain onboarding](domain-onboarding.md) for an isolated
   subdomain, apply the returned DKIM records through the authoritative DNS
   owner, refresh SES state, and confirm both domain and DKIM status are
   verified. HayaSend never changes DNS.
6. Send canary messages to controlled recipients.
7. Confirm `email.sent` and `email.delivered` webhooks.
8. Confirm that a controlled permanent bounce creates a suppression.
9. Upload a canary attachment, send it, and confirm the retrieved email
   contains metadata but no attachment body or S3 object key.

Do not use the bootstrap key in normal application traffic.

If inbound receiving is enabled, complete the separate pre-MX checklist in
[Inbound receiving](inbound-receiving.md): register an `email.received`
webhook, send a canary to the receiving subdomain, retrieve its raw MIME and
attachment through the API, and only then move important mail flow.

## API throttling and cost boundary

New stacks target 10 requests per second with a token-bucket burst of 20 across
all HTTP API routes. Set `--api-rate-limit` and `--api-burst-limit` during a
reviewed deployment when observed traffic or the SES sending quota requires a
different boundary. The CLI preserves configured values; its first update of a
stack created before these parameters existed preserves the earlier fixed
50/100 behavior.

API Gateway applies these targets on a best-effort basis. They are neither a
per-key quota nor a guaranteed request or cost ceiling, and account/Region
quotas can impose a lower limit. A throttled request can receive `429 Too Many
Requests`. Clients should use exponential backoff with jitter and reuse the
same idempotency key when retrying a create request.

Create an [AWS Budget](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html)
with actual-cost notifications before exposing an endpoint. Budget data and
alerts can lag incurred usage, so combine them with API Gateway and Lambda
metrics and a separately reviewed edge-control design when stronger abuse
protection is required. Do not treat raising the API throttle as permission to
exceed the SES sending quota.

## Lambda log retention

Every deployed function writes to a stack-owned log group under
`/hayasend/<stack-name>/`. `LogRetentionDays` defaults to 30 and accepts only
CloudWatch Logs' supported finite retention values. Select a value that meets
incident-response, legal, and audit requirements; cost alone is not a reason to
discard required evidence. CloudWatch Logs encrypts these groups at rest with
its default service-side encryption; HayaSend does not attach a
customer-managed KMS key. The legacy migration changes only retention and
therefore preserves any existing KMS association.

Audit the effective value without reading log events:

```bash
stack_name=hayasend
aws logs describe-log-groups \
  --log-group-name-prefix "/hayasend/$stack_name/" \
  --query 'logGroups[].{name:logGroupName,retention:retentionInDays}'
```

An update from an older HayaSend template may already have Lambda-created
groups named `/aws/lambda/<physical-function-name>`. CloudFormation cannot
automatically import those dynamically named groups. The checked-in migration
custom resource therefore inspects only exact log-group metadata and applies
the selected finite retention to groups that exist. It never calls log-event
read APIs, moves events, deletes a legacy group, or creates a missing legacy
group. New invocations switch to the stack-owned groups.

The migration is transactional within an invocation. If a later update fails,
the helper restores every group it already changed to its observed prior
finite policy—or removes the policy if it was previously unlimited—before
reporting failure. CloudFormation rollback then invokes it with the old
parameter. If a stack reaches `UPDATE_ROLLBACK_FAILED`, inspect the
`LegacyFunctionLogRetention` event, continue rollback, and audit both prefixes
before retrying. Do not delete a legacy group to make an update pass.

To roll back a retention change, redeploy an earlier allowed
`LogRetentionDays` value. Reducing retention can mark older events for deletion;
AWS notes that physical deletion can take up to 72 hours. Stack deletion
deliberately deletes the stack-owned `/hayasend/...` groups so the same stack
name can be recreated. Legacy `/aws/lambda/...` groups are not owned or deleted
by the migration and retain their last finite policy. A replacement of a
stack-owned group is retained as a recovery safeguard. The migration resource
has an explicit dependency on its provider log group. Lambda can still
re-create that exact group when CloudFormation invokes the provider's delete
callback, so the callback suppresses successful platform logs and removes only
its own stack-derived group before acknowledging deletion. Its role cannot
delete legacy function groups or read log events.

See the AWS documentation for
[custom Lambda log groups](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-loggroups.html),
[log-group retention](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-loggroup.html),
and
[`PutRetentionPolicy`](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutRetentionPolicy.html).

## Template publication history

Choose retention as part of the deployment review. The defaults keep the
latest 50 publications for 90 days; the supported ranges are 1–50 versions
and 1–365 days. Increasing either raises DynamoDB storage and backup size.
Count pruning happens in the publication transaction. TTL cleanup can lag, but
expired versions are refused by the API immediately.

History-list responses contain operational metadata but no template body.
Individual inspection and rendering return retained content, so restrict
`templates:read` to trusted deployment and support principals. Restore also
requires `templates:write` and an exact current-draft `If-Match`; it creates a
new draft and leaves the active published snapshot untouched. Render and
review that draft before conditionally publishing it.

For incident recovery, record the historical version ID and current draft
version before restore. A not-found response can mean the version was pruned,
expired, deleted with its template, or belongs to another template; do not
bypass that boundary by editing DynamoDB directly.

## Alarms

| Alarm | Immediate response |
|---|---|
| Dead-letter queue contains a job | Use the allowlisted job type, opaque message ID, and error category to inspect the source service before redrive |
| Scheduler dead-letter queue contains an invocation | Inspect Scheduler target permissions and the original email ID; do not redrive the envelope directly into the job queue |
| Scheduler invocation dropped | Check `AWS/Scheduler` target errors, throttling, execution-role trust, and SQS permissions |
| Inbound dead-letter queue contains an event | Preserve the raw object, inspect parser/storage permissions without logging message content, then retry the original event |
| Queue age exceeds five minutes | Check Lambda concurrency, throttles, SES quota, and downstream webhooks |
| Oldest outbox item exceeds five minutes | Check the dispatcher Lambda, its DynamoDB GSI query and transaction permissions, and SQS availability; do not delete the row |
| Outbox lease expires | Inspect dispatcher timeout or process loss, then allow the next conditional sweep to reclaim it |
| Outbox dispatch failure | Check SQS availability and the dispatcher role; the item has already been released for retry |
| API internal error | Use the response's server-generated `x-request-id` to correlate API logs |
| Email fails with `provider_rejected` on its first attempt | Inspect SES identity, account status, configuration set, and request validity; fix the permanent condition before creating a new send |
| Send retries exhausted | Use the email ID and error category to inspect SES account state, identity, configuration set, and controlled provider diagnostics |
| Complaint received | Confirm suppression creation and review the originating traffic |

## Attachment uploads

Direct-upload URLs expire after 15 minutes. A caller can reference a verified
upload for 24 hours; accepted email payloads and attachment objects remain for
45 days, covering the 30-day scheduling window.

If email creation says the attachment was not uploaded, confirm the client sent
the exact `upload_headers` returned by `POST /attachments`, including
`x-amz-checksum-sha256` in AWS mode. A size or checksum mismatch requires a new
upload declaration. Do not bypass the integrity check or replace the object
manually.

The API and worker both read the payload bucket, while only the API can create
upload URLs. Investigate unexpected `HeadObject`, `GetObject`, or `PutObject`
authorization errors against those separate IAM roles.

Never copy raw message bodies, recipient lists, API keys, or webhook secrets
into tickets.

Application logs and retained failure fields intentionally use stable
categories such as `application_error`, `invalid_data`, `network_dns`,
`network_refused`, `network_reset`, `provider_rejected`,
`provider_throttled`, `provider_unavailable`, and `timeout`. They do not
contain provider exception strings. Correlate an API failure with the
server-generated response `x-request-id`, or an asynchronous failure with its
opaque email or queue message ID. Inspect SES, Lambda, SQS, DNS, and CloudTrail
under controlled access for the underlying detail; do not paste that detail
back into CloudWatch logs or public issues.

## Inbound receiving

The inbound bucket and KMS key are retained when CloudFormation deletes the
stack. This protects received mail from accidental stack deletion but means
decommissioning requires a separate, deliberate data-destruction procedure.
Record the retention decision and recovery window before emptying the bucket
or scheduling KMS key deletion.

Mail Manager can invoke the parser more than once for a message. This is
expected: the deterministic received ID and DynamoDB processing lease collapse
duplicates. Webhook delivery remains at least once, so downstream consumers
must deduplicate on `data.email_id`.

If a received email is visible in S3 but absent from the API:

1. check the inbound DLQ and parser Lambda error count;
2. verify the Mail Manager rule executed Write to S3 before Invoke Lambda;
3. verify the object key is `inbound/raw/<SES messageId>`;
4. check KMS decrypt and S3 read/write permissions for the parser role;
5. redrive after the failed invocation has released its processing lease (or
   after the 150-second crash-recovery lease expires).

Never paste the raw MIME into logs or issue trackers. Use object identifiers
and request IDs during diagnosis.

## Transactional outbox recovery

`POST /emails` and each preflighted batch entry atomically commit the legacy
email, provider-neutral message and recipients, idempotency claim, and
deterministic outbox row before returning success. Failure of the immediate
SQS or EventBridge Scheduler wake does not fail the request. The scheduled
dispatcher recovers due work without client replay.

Use the dashboard's `OutboxUndispatched`, `OutboxDue`,
`OutboxOldestDueAge`, `OutboxStuckLeases`, and
`OutboxDispatchFailures` metrics. A nonzero `OutboxMetricsTruncated` means the
bounded diagnostic query reached 1,000 rows; treat the visible counts as lower
bounds and prioritize draining the backlog. Metrics intentionally expose no
recipient, address, subject, body, payload reference, provider response, or
queue endpoint.

Never delete or hand-edit a stuck outbox row as the first response. Restore
the dispatcher table/GSI and SQS permissions, verify the queue, and let the
conditional lease recover it. An expired lease is reclaimable. Queue
acceptance followed by acknowledgement loss can create another job with the
same deterministic ID; the send lease prevents concurrent provider
submission.

Idempotency keys remain important for ambiguous HTTP results. Retry the
identical payload with the same key when the caller did not receive a response.
A changed payload conflicts, while a new key creates a distinct delivery
intent.

## Recipient ledger and provider-event recovery

Provider submission attempts are stored beside their message and recipients.
SES notifications are stored separately under an immutable provider-event
identity and indexed by email ID. A duplicate SNS `MessageId` is expected and
does not add a second event. Delivery, delay, bounce, and complaint events must
resolve their normalized address to a recipient on the accepted SES attempt.
Open and click evidence for a multi-recipient submission intentionally has no
recipient IDs; do not hand-edit it to guess an attribution.

If the SES-event Lambda moves an item to its DLQ:

1. use only the opaque HayaSend email ID, SNS message ID, provider message ID,
   and safe error category in logs or tickets;
2. verify the email has exactly one accepted attempt with that provider
   message ID;
3. verify the event's exact recipient is part of that attempt;
4. correct permissions or normalization code, then redrive the original SNS
   envelope;
5. confirm the immutable event appears once and the recipient status did not
   regress.

Do not delete an existing provider event to force a replay, and do not paste
the SNS message, SMTP response, address, subject, or body into a ticket. A
recognized duplicate or older event still produces the normalized outward
webhook, while current recipient state remains conservative.

## Upgrade and rollback

The transactional outbox deployment is additive to the v0.1 single-table
layout and reuses the existing `GSI1`; CloudFormation must not replace the
DynamoDB table. Existing v0.1 emails remain readable. Jobs and Scheduler
entries that were accepted before upgrade continue to reload the legacy email
record, while newly created messages also receive delivery, attempt, event,
recipient, and outbox records.

Before upgrading:

1. retain the DynamoDB point-in-time recovery setting and record a recovery
   timestamp;
2. inspect the CloudFormation change set and reject any DynamoDB replacement;
3. confirm the worker and dispatcher roles have only the checked-in table,
   index, and queue permissions;
4. deploy a canary and verify the dispatcher acknowledges its outbox row.

Rollback is safe only after `OutboxUndispatched`, `OutboxDue`, and
`OutboxLeased` are all zero for two consecutive one-minute samples and no
stuck lease exists. Pause new API writes, drain the outbox, retain the table,
then roll application functions back. Rolling back while an undispatched
post-upgrade row exists strands that delivery because v0.1 has no dispatcher.
If the drain cannot finish, roll forward with the corrected dispatcher instead
of discarding committed intent.

## Dead-letter queue

1. Pause the producer if the failure is systemic.
2. Inspect a small sample without exposing payloads.
3. Fix the underlying permission, provider, code, or endpoint problem.
4. Redrive messages using the SQS dead-letter queue redrive operation.
5. Watch queue age, job failures, and downstream event state.

Webhook jobs may be retried safely when consumers deduplicate `svix-id`.
Send jobs are protected by a state lease,
but a rare duplicate remains possible if SES accepted a message before a
worker stopped without recording the provider ID.

AWS-mode webhook endpoints must remain publicly resolvable over HTTPS. A DNS
change to any private, loopback, link-local, reserved, or mixed public/private
answer intentionally fails delivery and eventually moves the job to the DLQ.
HayaSend does not follow webhook redirects; register the final canonical URL.

Webhook delivery summaries are available from
`GET /webhooks/{id}/deliveries`; retrieve the retained event with
`GET /webhooks/{id}/deliveries/{deliveryId}`. After correcting an endpoint,
`POST /webhooks/{id}/deliveries/{deliveryId}/replay` creates a new message ID
linked by `replayed_from`. Automatic SQS retries deliberately keep the
original `svix-id`. A delivery can therefore move from `failed` to
`succeeded`; use its attempt count and last-attempt fields rather than treating
the first failure as final.

The same recovery flow is available without hand-built HTTP requests:

```bash
npm run cli -- webhooks deliveries WEBHOOK_ID --limit 20
npm run cli -- webhooks inspect-delivery WEBHOOK_ID DELIVERY_ID
npm run cli -- webhooks replay WEBHOOK_ID DELIVERY_ID --yes
```

Replay is intentionally gated by `--yes`. Webhook creation likewise requires
`--secret-file PATH`; the CLI stores the one-time secret in a new mode-`0600`
file and excludes it from JSON output. See the
[CLI guide](cli.md#manage-and-recover-webhooks) for the full lifecycle.

Set `WebhookDeliveryRetentionDays` to the shortest useful recovery window.
Expired records are excluded from reads immediately, although DynamoDB TTL can
take additional time to delete them physically. Delivery history contains
event metadata such as recipient addresses and subject lines; do not export it
to tickets or analytics by default.

The Scheduler DLQ is separate from the worker DLQ because its messages are
Scheduler delivery envelopes rather than HayaSend jobs. After fixing the
cause, recover the referenced email by rescheduling it through the API instead
of redriving the raw Scheduler envelope.

## Key rotation

1. Create a new key with the smallest necessary scopes.
2. Update the consuming workload's secret.
3. Verify traffic using the new key.
4. Revoke the old key with `DELETE /api-keys/{id}`.

The API never returns an application token after creation.

To rotate the bootstrap key, write a new random value of at least 32
characters to the secret identified by the `BootstrapSecretArn` stack output.
Wait up to five minutes for the API function's bounded cache to expire, or
publish a no-code Lambda configuration update to force fresh execution
environments. Verify the new key, then confirm the old key returns `401`.

Application-key authentication does not require Secrets Manager and continues
to work during a temporary Secrets Manager outage.

## Suppressions

Permanent bounces and complaints are inserted automatically. Manual entries
use `POST /suppressions`. Removing an entry can damage sender reputation, so
confirm the mailbox is valid and the recipient has requested mail before
calling `DELETE /suppressions/{email}`.

Use the CLI to avoid hand-building recipient-bearing URLs and JSON:

```bash
npm run cli -- suppressions add --email-file /secure/path/recipient.txt
npm run cli -- suppressions get --email-file /secure/path/recipient.txt
npm run cli -- suppressions delete \
  --email-file /secure/path/recipient.txt \
  --yes
```

`delete` requires an explicit acknowledgement. CLI responses contain recipient
data; keep them out of public issues and broad log pipelines. HayaSend's
suppression store is independent of the Amazon SES account-level suppression
list, so investigate both before restoring delivery. See
[the CLI guide](cli.md#manage-suppressions-safely) for file limits and scopes.

Transient bounces are not automatically suppressed.

## Incident priorities

1. Stop unwanted or abusive sends.
2. Revoke exposed keys.
3. Preserve CloudTrail and application logs.
4. Confirm suppression and complaint processing.
5. Notify affected operators without copying message content.
6. Restore traffic gradually with a canary.
