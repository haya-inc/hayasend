# Roadmap

The roadmap is ordered by user risk, not by feature count.

## v0.1 — Transactional foundation

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
- [ ] first successful deployment integration run in a dedicated AWS test
  account (OIDC deploy/test/delete workflow is ready)
- [x] bootstrap-key storage in Secrets Manager

## v0.2 — Receive and forward

- [x] SES Mail Manager ingress endpoint and traffic policies
- [x] encrypted S3 raw-message storage with configurable expiry
- [x] `email.received` webhook and temporary attachment URLs
- [x] deterministic receipt duplicate suppression
- [x] explicit received-message forwarding through the official Node SDK
- [ ] alias routing and catch-all rules
- [ ] automatic forwarding that rewrites sender headers safely
- [ ] loop detection and ARC preservation

## v0.3 — Developer workflow

- [x] hardened local container quickstart
- [x] signed, multi-platform container and SBOM release automation
- [ ] first signed public release
- [x] local preview inbox
- template versions using React Email
- `hayasend init`, `deploy`, `doctor`, `test`, and migration commands
- OpenTelemetry exports and operational dashboard
- Python, Go, and direct HTTP contract tests

## v1 — Supported operations

- stable compatibility contract and upgrade policy
- multi-account and multi-region management
- SSO, audit exports, and configurable retention
- backup, restore, disaster-recovery, and load-test evidence
- published community and commercial support levels

## Later

Contacts, broadcasts, journeys, and marketing automation are intentionally
deferred. They require consent, unsubscribe, suppression, abuse, and regional
compliance controls that should not be rushed.
