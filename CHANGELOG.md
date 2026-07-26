# Changelog

All notable user-facing changes will be documented here. HayaSend follows
[Semantic Versioning](https://semver.org/) while allowing breaking changes in
minor releases before v1.0.

## Unreleased

No unreleased changes.

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
