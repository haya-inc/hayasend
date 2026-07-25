# Operations runbook

This runbook is the minimum operating procedure for an AWS deployment.

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

## Alarms

| Alarm | Immediate response |
|---|---|
| Dead-letter queue contains a job | Inspect the job type and error logs before redrive |
| Scheduler dead-letter queue contains an invocation | Inspect Scheduler target permissions and the original email ID; do not redrive the envelope directly into the job queue |
| Scheduler invocation dropped | Check `AWS/Scheduler` target errors, throttling, execution-role trust, and SQS permissions |
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
