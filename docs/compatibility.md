# Resend compatibility

HayaSend targets behavioral compatibility where it creates a low-friction
migration path. It does not claim full Resend API coverage.

| Resource | Operation | Status | Notes |
|---|---|---:|---|
| Emails | send | Implemented | HTML, text, recipients, headers, tags |
| Emails | retrieve/list | Implemented | HayaSend adds internal status fields |
| Emails | update/cancel | Implemented | queued or scheduled messages only |
| Batch | send | Implemented | 1–100 messages |
| Attachments | base64 content | Implemented | 6 MiB decoded aggregate guardrail |
| Attachments | remote path | Rejected | avoids server-side URL fetching |
| Scheduling | ISO 8601 | Implemented | SQS up to 15 minutes; EventBridge Scheduler beyond |
| Scheduling | relative English | Partial | `in N minutes/hours/days` |
| Domains | create/get/list/delete/verify | Implemented | Amazon SES identities |
| Webhooks | create/get/list/delete | Implemented | signed `svix-*` headers |
| Webhooks | delivery retry | Implemented | SQS and dead-letter queue |
| API keys | scoped create/list/revoke | HayaSend extension | secrets stored as hashes |
| Suppressions | hard bounce/complaint/manual | HayaSend extension | checked before enqueue |
| Receiving | inbound API | Planned | v0.2 |
| Templates | hosted templates | Planned | React Email remains usable client-side |
| Contacts/broadcasts | marketing APIs | Not planned for v1 | compliance work required |

The CI suite constructs the official `resend` Node SDK with a custom `baseUrl`
and sends a real SDK request through the HayaSend application.

Compatibility bugs should include the SDK name and version, the smallest safe
payload that reproduces the issue, and the expected response shape.
