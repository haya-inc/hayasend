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
- [ ] EventBridge Scheduler for long schedules
- [ ] presigned S3 attachment uploads beyond the API Gateway payload limit
- [ ] deployment integration test in a dedicated AWS test account
- [x] bootstrap-key storage in Secrets Manager

## v0.2 — Receive and forward

- SES Mail Manager ingress endpoint and traffic policies
- encrypted S3 raw-message storage with configurable expiry
- `email.received` webhook and temporary attachment URLs
- alias routing and catch-all rules
- forwarding that rewrites sender headers safely
- loop detection, duplicate suppression, and ARC preservation

## v0.3 — Developer workflow

- local preview inbox
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
