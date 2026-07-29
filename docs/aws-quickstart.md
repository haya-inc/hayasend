# AWS quickstart

This is the shortest supported path for creating, checking, updating, and
removing a HayaSend AWS deployment. Use an exact released HayaSend version in
every infrastructure command.

## 1. Sign in and set the target once

Install Node.js 24 or newer, npm 12 or newer, the current AWS CLI v2, and the
current AWS SAM CLI. Sign in with your normal AWS SSO profile:

```bash
export AWS_PROFILE=your-sso-profile
export AWS_REGION=ap-northeast-1
aws sso login --profile "$AWS_PROFILE"

export HAYASEND_AWS_ACCOUNT_ID="$(
  aws sts get-caller-identity --query Account --output text
)"
export HAYASEND_VERSION=X.Y.Z
```

`HAYASEND_AWS_ACCOUNT_ID` and `AWS_REGION` are non-secret configuration. Every
HayaSend AWS command calls STS and refuses to continue when the authenticated
account differs. Pass `--account`, `--region`, `--stack`, or `--profile` only
when overriding these defaults. The default stack name is `hayasend`.

## 2. Create the stack

Generate a read-only plan:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" deploy aws
```

Review the account, Region, SES state, parameters, tags, and exact apply
command in the JSON result. Then apply:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" deploy aws \
  --enable-restore-testing \
  --apply
```

Apply builds the packaged SAM application, creates an unexecuted
CloudFormation change set, prints every resource action, and executes it only
when no unacknowledged removal or possible replacement exists. HayaSend never
changes DNS. After a successful create or update, the CLI enforces a stack
policy that denies replacement or deletion of retained data resources and
enables CloudFormation termination protection. Apply fails loudly if either
protection cannot be verified.

New stacks protect the DynamoDB ledger and versioned payload bucket with a
daily AWS Backup plan and 35-day retention. The production example explicitly
adds weekly isolated restore testing. Restore jobs are billable, so omit
`--enable-restore-testing` for a short-lived proof. Review the retention and
backup resource names in the plan before applying.

## 3. Enable safe updates

AWS needs an earlier Lambda version before CodeDeploy can shift traffic.
The first apply therefore creates the `live` aliases only. Review and apply
the exact next command returned by that deployment:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" upgrade aws
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" upgrade aws --apply
```

That second update adds CodeDeploy deployment groups. Subsequent Lambda
updates shift 10% of traffic for five minutes by default and automatically
roll back when the alias-specific error alarm fires or CodeDeploy reports a
failure. Set `--deployment-preference-type` on a reviewed plan to choose one
of the documented AWS SAM canary or linear strategies.

## 4. Check whether it is ready

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" status aws
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" status aws --detect-drift
```

The first command is a read-only snapshot of the last reported drift state.
The second explicitly starts a new CloudFormation drift check and waits up to
10 minutes for it to finish. Fresh drift output contains logical IDs, resource
types, and statuses only; it does not print property values.

The result keeps two decisions separate:

- `operational` requires a stable stack, verified termination protection, the
  HayaSend retained-resource stack policy, an `IN_SYNC` drift result, no
  problematic stack resources, all required Lambda aliases and CodeDeploy
  deployment groups, all configured backup and restore-testing resources, all
  discovered HayaSend alarms in `OK`, and a successful public `/healthz`
  request;
- `send_ready` additionally requires SES production access and account
  sending to be enabled.

The result includes SES quota, only problematic resource and alarm details,
the CloudWatch dashboard URL, and exact update, cleanup, and deep-diagnostics
commands. It does not read the bootstrap secret or API keys.

For authenticated application and queue diagnostics, set a scoped key locally
and run:

```bash
export HAYASEND_BASE_URL=https://your-api.example
export HAYASEND_API_KEY=your-scoped-diagnostics-key
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" doctor
```

Keep the key in an approved secret manager and out of command arguments,
transcripts, and issue reports.

## 5. Update safely

Plan an update to the existing stack:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" upgrade aws
```

After reviewing the plan:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" upgrade aws --apply
```

`upgrade aws` refuses a missing or non-terminal stack and uses the same exact
change-set inspection as initial deployment. If CloudFormation proposes any
removal, indeterminate action, or possible replacement, it stops before
execution. Use `--allow-destructive-changes` only after reviewing every
printed destructive action.

Run `status aws` again after every update.

## 6. Remove the running stack

First print the deletion plan:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" cleanup aws
```

Cleanup refuses an unmanaged or non-terminal stack. A protected stack remains
plan-able, but deletion requires both its exact name and a separate
acknowledgement that termination protection will be disabled:

```bash
npx --yes "@haya-inc/hayasend@${HAYASEND_VERSION}" cleanup aws \
  --apply \
  --confirm-stack hayasend \
  --disable-termination-protection
```

The CLI verifies the protection change before submitting deletion. If the
delete request itself fails, it attempts to re-enable termination protection.
It then waits for `stack-delete-complete` and verifies that the stack no longer
exists. It does not purge retained customer data. The DynamoDB table, payload
bucket, and enabled inbound bucket and KMS key have `DeletionPolicy: Retain`;
their physical IDs are printed before and after deletion. Decide their
retention, export, and eventual destruction separately under the applicable
backup, audit, and privacy policy. The backup vault is also retained; recovery
points must expire or be copied under policy before a separately reviewed
vault deletion.

## Routine operating loop

Run `status aws --detect-drift` after deployment, after updates, after AWS
incidents, and before production canaries. Subscribe a real on-call
destination to the `AlarmTopicArn`, confirm that subscription, configure an
AWS Budget, and use the generated dashboard as the first operational view.
The complete response procedures are in the
[operations runbook](operations.md).
