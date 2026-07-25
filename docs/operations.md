# Operations runbook

This runbook is the minimum operating procedure for an AWS deployment.
For disposable end-to-end validation, use the
[dedicated-account integration workflow](aws-integration-testing.md).

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

## Alarms

| Alarm | Immediate response |
|---|---|
| Dead-letter queue contains a job | Inspect the job type and error logs before redrive |
| Scheduler dead-letter queue contains an invocation | Inspect Scheduler target permissions and the original email ID; do not redrive the envelope directly into the job queue |
| Scheduler invocation dropped | Check `AWS/Scheduler` target errors, throttling, execution-role trust, and SQS permissions |
| Inbound dead-letter queue contains an event | Preserve the raw object, inspect parser/storage permissions without logging message content, then retry the original event |
| Queue age exceeds five minutes | Check Lambda concurrency, throttles, SES quota, and downstream webhooks |
| API internal error | Use `x-request-id` to correlate API logs |
| Send retries exhausted | Inspect SES response, account state, identity, and configuration set |
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

Webhook jobs may be retried safely. Send jobs are protected by a state lease,
but a rare duplicate remains possible if SES accepted a message before a
worker stopped without recording the provider ID.

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
