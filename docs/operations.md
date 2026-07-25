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

Do not use the bootstrap key in normal application traffic.

## Alarms

| Alarm | Immediate response |
|---|---|
| Dead-letter queue contains a job | Inspect the job type and error logs before redrive |
| Queue age exceeds five minutes | Check Lambda concurrency, throttles, SES quota, and downstream webhooks |
| API internal error | Use `x-request-id` to correlate API logs |
| Send retries exhausted | Inspect SES response, account state, identity, and configuration set |
| Complaint received | Confirm suppression creation and review the originating traffic |

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

## Key rotation

1. Create a new key with the smallest necessary scopes.
2. Update the consuming workload's secret.
3. Verify traffic using the new key.
4. Revoke the old key with `DELETE /api-keys/{id}`.
5. Rotate the bootstrap key through a stack update if it may have been
   disclosed.

The API never returns an application token after creation.

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
