# Portable backup and restore proof

HayaSend includes a provider-neutral, non-sending proof contract for a
PostgreSQL backup plus private attachment-store restoration. It does not create
provider backups itself. Provider workflows remain responsible for creating an
isolated backup, restoring it into a clean target, copying or restoring the
private object, and deleting every source, target, backup, and object afterward.

The proof has two modes:

1. `seed` creates one 8–30 day scheduled console-only email with one
   checksum-bound direct-upload attachment. It verifies the atomic ledger,
   idempotency claim, delayed durable job, object reference, and PostgreSQL
   version, then deliberately retains the fixture for an isolated backup.
2. `restore` verifies that the restored database state has the same SHA-256
   digest and attachment reference, removes the wake-up job, advances the
   authoritative due row, and waits for the restored worker to recover it. The
   worker must read and rehash the restored object before the console transport
   can accept the message.

Neither mode sends external email. The output excludes credentials, addresses,
content, signed upload URLs, and raw errors. Fixture IDs are included because
the restore verifier needs them; keep the JSON in access-controlled workflow
artifacts and publish only aggregate results.

## Seed

Build the exact reviewed source first:

```bash
npm ci
npm run build
```

Run the seed inside the source deployment:

```bash
export HAYASEND_BACKUP_RESTORE_PROOF_MODE=seed
export HAYASEND_BACKUP_RESTORE_PROOF_CONFIRM=isolated-backup-restore-proof
export HAYASEND_BACKUP_RESTORE_RETAIN_CONFIRM=retain-isolated-backup-fixture
export HAYASEND_HOSTED_PROOF_API_URL=https://api.example.invalid
export HAYASEND_DATABASE_URL=postgres://...
export HAYASEND_API_KEY=re_...
export HAYASEND_TRANSPORT=console
export HAYASEND_ATTACHMENT_UPLOAD_ORIGINS=https://objects.example.invalid
npm run proof:portable-backup-restore > backup-restore-seed.json
```

`HAYASEND_ATTACHMENT_UPLOAD_ORIGINS` is required only for a storage origin that
is neither the API origin nor a built-in AWS S3, Google Cloud Storage, Azure
Blob, or Vercel Blob hostname. HTTP is accepted only for loopback emulators.

After seed completion, create the provider database backup and the independently
specified object backup. Restore both into clean targets. Do not point the
restore verifier at the source resources.

## Restore

Run against the restored API, database, and private object store:

```bash
export HAYASEND_BACKUP_RESTORE_PROOF_MODE=restore
export HAYASEND_BACKUP_RESTORE_PROOF_CONFIRM=isolated-backup-restore-proof
export HAYASEND_BACKUP_RESTORE_SOURCE_FILE=/run/secrets/backup-restore-seed.json
export HAYASEND_HOSTED_PROOF_API_URL=https://restored-api.example.invalid
export HAYASEND_DATABASE_URL=postgres://...
export HAYASEND_API_KEY=re_...
export HAYASEND_TRANSPORT=console
npm run proof:portable-backup-restore > backup-restore-result.json
```

Success proves:

- restored ledger, outbox, idempotency, attachment reference, and future
  schedule match the source digest;
- the restored worker recovers work even after its wake-up job is removed;
- restored attachment bytes pass the runtime's size and SHA-256 checks; and
- no external send or terminal-delivery claim occurred.

The restore mode removes its database fixture and attachment metadata. It
cannot delete provider objects, snapshots, retained backups, logs, tokens, or
billable resources. The provider cleanup workflow must prove those separately.

## Required provider evidence

This contract is necessary but not sufficient. A provider acceptance record
must also include:

- exact source and restore resource identities kept private;
- backup creation, restore target, retention, encryption, and recovery-window
  observations;
- object backup or snapshot method and final byte-level checksum evidence;
- measured restore and recovery time;
- source and restore cleanup inventories, retained-copy disposition, and
  billing evidence; and
- a clear statement that console acceptance is not terminal recipient
  delivery.
