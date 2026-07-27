# Resend compatibility

HayaSend targets behavioral compatibility where it creates a low-friction
migration path. It does not claim full Resend API coverage.

| Resource            | Operation                                       |             Status | Notes                                                              |
| ------------------- | ----------------------------------------------- | -----------------: | ------------------------------------------------------------------ |
| Emails              | send                                            |        Implemented | HTML, text, recipients, headers, tags; bounded text fallback       |
| Emails              | retrieve/list                                   |        Implemented | resource-ID `after`; provider `message_id` after acceptance        |
| Emails              | update/cancel                                   |        Implemented | queued or scheduled messages only                                  |
| Batch               | send                                            |        Implemented | 1–100 messages; strict validation only, without permissive mode    |
| Attachments         | base64 content                                  |        Implemented | constrained by the 9 MiB serialized request guardrail              |
| Attachments         | direct upload                                   | HayaSend extension | checksum-bound S3 PUT; 25 MiB decoded aggregate                    |
| Attachments         | remote path                                     |           Rejected | avoids server-side URL fetching                                    |
| Scheduling          | ISO 8601                                        |        Implemented | durable outbox; SQS wake up to 15 minutes, Scheduler beyond        |
| Scheduling          | relative English                                |            Partial | `in N minutes/hours/days`                                          |
| Domains             | create/get/list/delete/verify                   |        Implemented | Node SDK gate; safe CLI; Amazon SES identities                      |
| Webhooks            | create/get/list/update/delete                   |        Implemented | signed `svix-*` headers; public HTTPS in AWS mode                  |
| Webhooks            | delivery retry                                  |        Implemented | stable `svix-id`, SQS, and dead-letter queue                       |
| Webhooks            | delivery history/replay                         | HayaSend extension | configurable 1–30 day TTL; replay creates a linked message ID      |
| API keys            | scoped create/list/revoke                       | HayaSend extension | secrets stored as hashes                                           |
| Suppressions        | hard bounce/complaint/manual                    | HayaSend extension | checked before enqueue                                             |
| Receiving           | list/retrieve                                   |        Implemented | opt-in Mail Manager deployment; bounded `data_uri` or `cid` HTML   |
| Receiving           | `email.received` webhook                        |        Implemented | metadata only; signed and retried through SQS                      |
| Receiving           | raw MIME and attachments                        |        Implemented | 15-minute S3 download URLs                                         |
| Receiving           | official SDK forward helper                     |        Implemented | raw MIME is parsed client-side, then sent through the normal API   |
| Receiving           | automatic alias routing                         |            Planned | loop detection and ARC-aware policy remain v0.2 work               |
| Templates           | create/get/list/update/publish/duplicate/delete |        Implemented | ID or alias; isolated draft/published snapshots                    |
| Templates           | send/batch send                                 |        Implemented | typed variables, fallbacks, text derivation, and default overrides |
| Templates           | React Email                                     |        Implemented | official SDK renders locally with `@react-email/render`            |
| Templates           | CLI list/get/publish/send                       |        Implemented | Resend-shaped commands and repeatable `--var` values               |
| Templates           | manifest reconciliation                         | HayaSend extension | dry-run, drifted drafts only, and explicit publication             |
| Templates           | draft render/conditional publish                | HayaSend extension | no-send preview and version-bound promotion                        |
| Templates           | publication history/restore                     | HayaSend extension | bounded immutable history; restore creates an unpublished draft    |
| Contacts/broadcasts | marketing APIs                                  | Not planned for v1 | compliance work required                                           |

The CI suite constructs the official `resend` Node SDK with a custom `baseUrl`
and exercises sending, resource-ID list pagination, domain lifecycle, webhook
management, received-email listing/retrieval, received attachment
listing/retrieval, raw-MIME forwarding, hosted-template lifecycle, React Email
rendering, and template sending through the HayaSend application. A separate
black-box gate points the official Resend Python SDK's `api_url` at a loopback
HayaSend server and verifies send, retrieve, list, and batch behavior without
an SDK fork.

A third black-box gate runs the official Schemathesis v4.24.3 container,
pinned by OCI digest, against all 46 operations in the published OpenAPI
contract. Deterministic positive and negative generation verifies that
unknown inputs do not produce server errors and that status codes, content
types, and response bodies match the contract. The target guard accepts only
a loopback origin, generated webhook registrations are confined to a
non-delivering loopback endpoint, and the ephemeral test container does not
export request or response bodies.

Compatibility bugs should include the SDK name and version, the smallest safe
payload that reproduces the issue, and the expected response shape.

Sent-email retrieve/list responses and provider-accepted outbound email
webhooks expose the SES identifier as `message_id`. Events emitted before SES
acceptance omit it rather than fabricating an RFC Message-ID.

For direct and batch sends, omitting `text` derives a bounded plain-text body
from `html`. Set `text` to an empty string to keep an HTML-only message.
