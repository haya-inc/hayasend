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
3. Create a scoped application key with the bootstrap administrator key.
4. Store the application token in the workload's secret manager.
5. Verify an isolated sending subdomain and confirm DKIM.
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

Transient bounces are not automatically suppressed.

## Incident priorities

1. Stop unwanted or abusive sends.
2. Revoke exposed keys.
3. Preserve CloudTrail and application logs.
4. Confirm suppression and complaint processing.
5. Notify affected operators without copying message content.
6. Restore traffic gradually with a canary.
