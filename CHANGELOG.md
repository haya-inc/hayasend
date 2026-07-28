# Changelog

All notable user-facing changes will be documented here. HayaSend follows
[Semantic Versioning](https://semver.org/) while allowing breaking changes in
minor releases before v1.0.

## Unreleased

## 0.3.0 - 2026-07-29

- Define independent, versioned runtime, transport, and combined-deployment
  capability contracts so HayaSend can preserve one Resend-compatible API and
  recipient ledger while changing clouds and mail providers.
- Add the portable PostgreSQL data plane with atomic ledger/outbox commits,
  migrations, API and worker processes, bounded leases and retries, durable
  due-row reconciliation, health/readiness/doctor surfaces, and recovery of
  long schedules without treating a queue as the source of truth.
- Add private S3-compatible, Google Cloud Storage, Azure Blob, Railway Bucket,
  Vercel Blob, and Cloudflare R2 attachment backends with checksum-bound direct
  uploads and customer-controlled credential boundaries.
- Add experimental deployment packs for Cloud Run, Render, Railway, Fly.io,
  Azure Container Apps, and Vercel, including migration-first rollout,
  immutable-image checks, guarded rollback/cleanup, and explicit
  backup/restore and zero-residue evidence gates.
- Add an optional least-privilege Google Pub/Sub wake-up accelerator for Cloud
  Run. PostgreSQL remains authoritative, delayed work never depends on Pub/Sub,
  and publication fails open only after durable enqueue succeeds.
- Add Azure Communication Services Email submission, domain/quota capability
  reporting, acceptance-ambiguous handling, and recipient-level Event Grid
  delivery-event convergence.
- Add a signed SendGrid HTTP transport with provider-message correlation,
  custom-domain capability reporting, pre-submission limits, privacy-safe
  errors, and duplicate/out-of-order Signed Event Webhook convergence for
  portable runtimes.
- Add an explicitly non-production Cloudflare Workers runtime skeleton, a
  Node/AWS dependency boundary, Web Worker type-checking, and a Wrangler
  dry-run bundle gate while preserving the existing AWS runtime behavior.
- Add experimental, not-yet-wired Cloudflare D1, R2, and Queues adapters with
  the shared delivery-ledger and durable-outbox contract, transactional D1
  commits, checksum-bound R2 payloads and orphan recovery, deterministic Queue
  retries and DLQ recovery, privacy-safe diagnostics, and local workerd fault
  tests.
- Add an unwired Cloudflare Email Sending Beta provider proof with structured
  binding transport, privacy-safe documented error normalization, indexed
  provider-message correlation, all six per-domain Queue lifecycle events,
  bounce/complaint suppression, duplicate and out-of-order convergence,
  pre-commit 50-recipient/5 MiB enforcement, official Resend SDK coverage, and
  an honest conformance report that leaves hosted deploy/rollback to #104.
- Add scope-protected, privacy-safe recipient summaries and recovery
  diagnostics for mixed outcomes, ambiguous attempts, outbox age, stuck
  leases, SQS/DLQ depth, provider-event lag, and capability drift.
- Add a fail-closed Cloudflare Email Sending subscription doctor, subscription-
  aware cleanup, and a retained two-phase hosted proof that requires a
  correlated terminal `delivered` event instead of treating provider
  acceptance as recipient delivery.
- Expose privacy-safe recipient summaries from the Cloudflare Worker so hosted
  delivery proof can distinguish provider acceptance from terminal recipient
  state.
- Publish HayaSend at `hayasend.com` with the customer-owned deployment and
  paid-support boundary made explicit.

All new runtime and transport combinations retain their documented
experimental or Beta maturity until their exact hosted lifecycle, terminal
delivery, backup/restore, rollback, and zero-residue evidence passes.

## 0.2.0 - 2026-07-27

- Advance the project label from early alpha to early beta for non-critical
  AWS evaluation while keeping the pre-v1 compatibility warning explicit and
  making no production-readiness claim for Cloudflare.
- Add a production-capable `emails send` CLI with body files and stdin,
  multiple recipients, scheduling, metadata, idempotency, templates, and
  checksum-bound direct attachment uploads whose verified content keeps
  retries stable across fresh upload IDs.
- Add a secret-safe webhook lifecycle and delivery-recovery CLI with local
  event validation, permission-`0600` one-time secret storage, retained
  delivery inspection, and acknowledgement-gated deletion and replay.
- Add privacy-aware suppression CLI operations with bounded file input,
  normalized mailboxes, manual-only creation, and acknowledgement-gated
  deletion.
- Add a privacy-safe sent-email lifecycle CLI for listing and inspecting
  metadata, explicitly revealing content, and confirmed cancellation or
  rescheduling.
- Add safe sending-domain onboarding commands with strict local validation,
  explicit deletion acknowledgement, a manual-DNS boundary, and an official
  Resend Node SDK lifecycle contract.
- Add secret-safe CLI lifecycle management for scoped API keys, including
  exclusive mode-`0600` token files that are never printed or overwritten.
- Add a clean-built, install-tested HayaSend CLI package to signed releases
  and prepare public npm distribution with OIDC provenance, exact-integrity
  rerun protection, and a documented one-time bootstrap; npm-generated
  executable symlinks now invoke the CLI instead of exiting without output.
- Return Resend-compatible `403 validation_error` responses when an Amazon SES
  identity or local development domain has already been registered.
- Make the public HTTP API throttle configurable with conservative new-stack
  defaults, legacy-preserving upgrades, exact deploy plans, and cost-boundary
  guidance.
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
