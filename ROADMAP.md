# Roadmap

The roadmap is ordered by user risk, not by feature count.
The evidence gates, adapter contract, and current draft disposition are in the
[production semantics and Cloudflare proof](docs/execution-plan.md) plan.

## Completed release gate — AWS beta

- [x] Resend-compatible single and batch send endpoints
- [x] official Resend Node SDK contract test
- [x] idempotency, cancellation, and scheduling
- [x] SES transport and domain verification
- [x] delivery events and signed webhook retries
- [x] serverless AWS SAM deployment
- [x] API-key records with scopes, expiry, and revocation
- [x] suppression-list enforcement before enqueue
- [x] EventBridge Scheduler for long schedules
- [x] presigned S3 attachment uploads beyond the API Gateway payload limit
- [x] first successful deployment integration run in a dedicated AWS test
      account (OIDC deploy/test/delete workflow is ready)
- [x] bootstrap-key storage in Secrets Manager
- [x] protected-main merge, exact-main CodeQL, signed release, provenance, and
      live project site

## Now — Production semantics

- versioned provider capability and compatibility contract
- transactional outbox with automatic reconciliation
- immutable recipient, attempt, and provider-event ledger
- deterministic aggregates under duplicate and out-of-order events
- permanent/retryable provider failure classification
- fault-injection and per-adapter conformance reports
- safe deploy, doctor, upgrade, rollback, and recovery evidence
- scoped credentials, cost/rate controls, and content-private operations
- [x] searchable API reference generated from the versioned OpenAPI contract
- [x] attestable, version-pinned CLI package publication with npm provenance
- [x] secret-safe scoped API key lifecycle management
- [x] safe sending-domain onboarding CLI and official SDK lifecycle gate
- [x] secret-safe webhook lifecycle, delivery inspection, and replay CLI
- [x] privacy-aware suppression operations CLI
- [x] privacy-safe sent-email lifecycle CLI
- [x] production-capable non-interactive email send CLI

## Production qualification

- [ ] exact-main AWS SES terminal delivery, SNS event correlation, controlled
      mailbox receipt, and zero-residue cleanup
      ([#126](https://github.com/haya-inc/hayasend/issues/126))
- [ ] exact-main Cloudflare terminal delivery and controlled mailbox receipt
      while the provider remains explicitly Beta
      ([#122](https://github.com/haya-inc/hayasend/issues/122))
- [ ] 1,000-message, 14-day controlled provider-switch dogfood proof
      ([#105](https://github.com/haya-inc/hayasend/issues/105))
- [ ] private commercial intake and supported-production service boundary
      ([#129](https://github.com/haya-inc/hayasend/issues/129))
- [ ] DNSSEC, renewal, registrar-lock, and administrative-MFA evidence for
      `hayasend.com`
      ([#130](https://github.com/haya-inc/hayasend/issues/130))

The
[production-qualification milestone](https://github.com/haya-inc/hayasend/milestone/2)
is the public gate. Green CI alone does not satisfy these operational
requirements.

## Portability foundation

The accepted direction in
[#132](https://github.com/haya-inc/hayasend/issues/132) separates runtime
substrates from mail transports. Runtime, transport, and exact combined
readiness are published independently so a stable application contract can
move across Azure, GCP/Cloud Run, Vercel, Render, Railway, and Fly.io without
overstating support.

- [x] versioned runtime-capability and combined-deployment schemas
- [x] initial AWS and Cloudflare runtime/deployment truth documents
- [ ] `portable-postgres` API/worker reference runtime
- [ ] Cloud Run and generic container-PaaS deployment packs
- [ ] Azure Communication Services Email adapter and Event Grid ingestion
- [ ] Vercel experimental runtime proof with database-owned long scheduling

Architecture and contract extraction may proceed while production
qualification is open. Breadth-first provider implementations remain ordered
after the current terminal-delivery and dogfood evidence gates.

## Next — Cloudflare and FolioMCP proof

- Workers runtime using the same public API
- D1 metadata/outbox, R2 payloads, and Queues/DLQ
- Cloudflare Email Sending transport and recipient event normalization
- capability-aware 50-recipient and 5 MiB validation
- plan-first deploy, doctor, upgrade, rollback, and cost evidence
- identical shared conformance and fault-injection suite
- provider switch without application-code changes
- controlled non-critical FolioMCP dogfood

Cloudflare Email Sending is currently Beta. HayaSend will keep that status
visible until both Cloudflare's service status and HayaSend's evidence justify
changing it.

## Then — Agent-safe policy

- actor, application, agent, and intent identity
- draft, send, and external-send permission separation
- recipient/domain allowlists and deny rules
- hourly/daily send and cost budgets
- approval gates for sensitive, external, attachment, and high-volume sends
- sandbox sink, preview, kill switch, and immutable audit
- MCP only as an interface over enforced policy

## Parked until the proof is complete

- inbound alias routing, automatic forwarding, and ARC preservation
- more language SDK gates beyond the shared provider conformance work
- visual template-product expansion
- contacts, broadcasts, journeys, and marketing automation
- managed multi-tenant content data plane
- SMS, push, chat, or a general notification workflow builder

The existing AWS receiving implementation remains supported, but it does not
set the order of new work.
