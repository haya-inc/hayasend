# Changelog

All notable user-facing changes will be documented here. HayaSend follows
[Semantic Versioning](https://semver.org/) while allowing breaking changes in
minor releases before v1.0.

## Unreleased

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
