# Changelog

All notable user-facing changes will be documented here. HayaSend follows
[Semantic Versioning](https://semver.org/) while allowing breaking changes in
minor releases before v1.0.

## Unreleased

- Derive a bounded plain-text body from HTML for direct and batch sends while
  preserving explicit text and supporting `text: ""` as an opt-out.
- Stop retrying permanent SES request rejections while preserving retries for
  throttling, provider availability, network, timeout, and unknown failures.
- Repair missing SQS or EventBridge dispatch when an identical idempotent
  replay finds a stored queued or scheduled email.
- Publish a versioned AWS SES capability document, provider-neutral
  conformance cases, and generated schemas that CI checks for drift.
- Define versioned provider-neutral message, recipient, attempt, provider-event,
  and outbox records with privacy-safe diagnostics and deterministic identities.
- Add an atomic memory-store delivery commit and continuously recoverable
  deterministic outbox reconciler with lease and failure metrics.
- Add a DynamoDB transactional outbox, sparse due/lease index, bounded
  dispatcher, deterministic queue jobs, privacy-safe alarms, and live
  deploy/recover/delete proof. SQS and EventBridge Scheduler are now wake-up
  optimizations rather than delivery truth.
- Add an immutable provider-event and recipient-attempt ledger shared by the
  memory and DynamoDB adapters, with SNS event deduplication, exact
  recipient correlation, conservative message aggregates, sticky complaint and
  suppression safety, and no retained raw provider payloads.
- Expose the provider-assigned Message-ID through sent-email retrieve/list
  responses and provider-accepted outbound webhooks.
- Enforce the published OpenAPI error and validation contract with pinned,
  loopback-only property-based CI; malformed JSON and percent-encoded
  suppression paths now return public client errors instead of internal
  errors.
- Make all list APIs use stable resource-ID cursors, matching the documented
  `after` contract across local and DynamoDB-backed deployments.
- Publish a searchable, versioned API reference and downloadable OpenAPI
  contract through the project site, with reproducible generation, a
  checksum-pinned renderer, and CI verification.

## 0.1.0 - 2026-07-26

- Replace raw provider, network, queue, and parser failure text in application
  logs and retained failure fields with stable operational categories; issue
  server-generated request IDs for safe API correlation.
- Add a source-linked AWS cost model with Virginia and Tokyo price snapshots,
  explicit workload formulas, SES plan separation, optional inbound costs, and
  a CLI for substituting operator assumptions.
- Reject malformed scoped API keys before any DynamoDB or Secrets Manager
  lookup so unauthenticated input cannot turn storage limits into API errors.
- Preflight every email in a strict batch before persisting or queueing any
  message, preventing partial sends when a template or attachment is invalid.
- Pin integration credentials to the expected API Gateway endpoint, redact
  cleanup failures, and read template files through race-safe descriptors.
- Initial Resend-compatible sending, scheduling, receiving, webhook, and AWS
  deployment foundation.
- Add Resend-compatible hosted templates with aliases, typed variables,
  draft/published isolation, React Email SDK interoperability, and scoped API
  access.
- Add a safe template-as-code CLI with manifest validation, dry-run planning,
  idempotent draft reconciliation, explicit publication, and hosted-template
  sends.
- Add no-send draft rendering and optional version-bound publication so a
  concurrently changed draft cannot be promoted after review.
- Add an accessible, dependency-free project site with clear self-hosting and
  commercial-support boundaries, deployed through pinned GitHub Pages actions.
- Add a pinned black-box compatibility gate for the official Resend Python SDK
  covering send, retrieve, list, and batch operations.
- Publish an evidence-based v0.1 beta milestone and a labeled public roadmap
  with a bounded first contribution.
- Add a plan-first AWS deployment CLI that pins the target account, reports
  SES readiness, creates an inspectable CloudFormation change set only with
  `--apply`, and refuses destructive changes without a second acknowledgement.
- Retain immutable hosted-template publications with bounded count and TTL,
  metadata-only history lists, historical inspection and rendering, and
  concurrency-safe restore to a new draft without changing production sends.
