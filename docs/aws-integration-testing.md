# AWS integration testing

The `AWS integration` workflow deploys an ephemeral HayaSend stack into a
dedicated AWS account, exercises the live API, and deletes the stack and its
retained data resources. It is intentionally manual and never runs for pull
requests from forks.

Before creating resources, the workflow runs `hayasend deploy aws` in
non-mutating plan mode. It then repeats the exact account, Region, stack, log
retention, and tags with explicit `--apply`. This proves account pinning, SES
and stack preflight, clean SAM validation/build, creation of an unexecuted
change set, change-set inspection, and execution by the retrieved change-set
ARN. It also verifies that the CLI enabled termination protection, installed
the retained-resource stack policy, and completed a fresh `IN_SYNC` drift
check.

The default disposable-stack run passes `--disable-backups` and
`--disable-restore-testing` on every create and update. That avoids a retained
vault, scheduled backup jobs, and temporary restored resources in the shared
test account. It asserts the disabled state in both the reviewed plan and live
status.

The opt-in `prove_backup_restore` input changes that same reviewed deployment
to one-day backup retention plus restore testing. It creates an idempotent
scheduled delivery and attachment, acknowledges the durable outbox without
sending through SES, and starts exact-resource DynamoDB and S3 backups. The
workflow advances the ephemeral restore-testing plan to its next bounded run,
then requires both isolated restores to use those exact recovery points. It
compares the complete DynamoDB item-set digest and explicitly requires the
email, delivery message, two recipient rows, idempotency claim, acknowledged
outbox, and attachment record. It separately compares the attachment bytes,
length, content type, and metadata. Both restore jobs receive an AWS Backup
`SUCCESSFUL` validation result only after those checks pass.

After the clean install, the workflow creates empty groups at the four legacy
Lambda-generated names with no retention policy, changes `LogRetentionDays`
from 7 to 14, and applies a second reviewed change set. It asserts that both
the stack-owned and synthetic legacy groups report 14-day retention and that a
disabled inbound deployment created no inbound log group. SAM reports generated
permissions, subscriptions, and custom-resource updates as conditionally
replacing resources, so this disposable-account update supplies the CLI's
explicit destructive-change acknowledgement. The workflow then proves that the
legacy-retention custom resource kept the same physical ID. This exercises the
non-destructive adoption path without reading or fabricating log events.

`WorkerReservedConcurrency=0` is now the product default rather than a
workflow-only override, so the same configuration the workflow proves is the
one an operator deploys. Worker throughput stays bounded by
`WorkerMaximumConcurrency`, which caps SQS event-source scaling without
reserving account concurrency.

The opt-in `prove_canary_rollback` input runs only after the normal reviewed
upgrade has completed successfully. It records the live API alias version,
adds a harmless run-specific export to the API entry point in the ephemeral
checkout, and starts one new alarm-monitored canary. After CodeDeploy creates
the deployment, the workflow discovers each deployment group under the
stack-owned application and queries deployments with the required
application/group pair. It repeatedly holds the exact alias error alarm in
`ALARM` until the update fails. A pass requires CodeDeploy's original
deployment to stop or fail with `DEPLOYMENT_STOP_ON_ALARM` enabled, the linked
automatic rollback deployment to succeed, CloudFormation to finish
`UPDATE_ROLLBACK_COMPLETE`, the live alias to return to its exact prior
version, and the public health endpoint to remain healthy. The workflow then
waits through CloudFormation's bounded rollback transition, then restores the
exact reviewed source file and alarm state before any API or
backup proof continues. The post-rollback check uses the same public
`/healthz` endpoint as the deployed service and does not send API credentials.

## Safety boundary

Use an AWS account that contains no production resources or data. Enable an
AWS Budget and root-account alerts before the first run. The workflow:

- authenticates with GitHub OIDC and stores no long-lived AWS key;
- fails if STS returns an account other than `AWS_TEST_ACCOUNT_ID`;
- runs through the protected `aws-integration` GitHub environment;
- creates a unique CloudFormation stack per run;
- proves the required two-phase Lambda rollout by creating aliases first and
  enabling alarm-driven CodeDeploy deployment groups on the reviewed update;
- when `prove_canary_rollback` is enabled, mutates only the ephemeral checkout,
  alarms only the exact stack-owned API alias alarm, requires the linked
  CodeDeploy automatic rollback, and verifies the original alias and health;
- sends no email to SES;
- cancels every test schedule and deletes its temporary SES identity;
- deletes the synthetic legacy and stack-owned CloudWatch log groups;
- explicitly acknowledges termination-protection disable, deletes the stack
  through `cleanup aws`, then deletes the S3 bucket and DynamoDB table retained
  by HayaSend's production-safe deletion policies. Payload cleanup is
  version-aware and removes every object version and delete marker through an
  exact-account and exact-bucket confirmation before bucket deletion;
- when `prove_backup_restore` is enabled, accepts restored resources only from
  exact jobs for the exact source ARNs, requires the S3 target to use AWS
  Backup's isolated restore-test name, deletes the restored table and every
  restored object version, deletes the exact recovery points, and verifies
  their absence before deleting the retained ephemeral vault.

Cleanup allows up to 60 seconds for CloudWatch's post-stack deletion view to
converge. A stack-owned group still visible after that bound is reported,
deleted to leave the account clean, and treated as a failed run.

The `retain_stack` input defaults to false. Enable it only for active
debugging, and delete the retained resources immediately afterward. Restore
proof resources are still removed because they are short-lived, billable
copies rather than the retained source stack.

## GitHub environment

Create an environment named `aws-integration`. Restrict deployments to the
default branch and add a required reviewer. Set these environment variables:

| Variable              | Example                                                    | Purpose                |
| --------------------- | ---------------------------------------------------------- | ---------------------- |
| `AWS_TEST_ACCOUNT_ID` | `123456789012`                                             | hard account allowlist |
| `AWS_TEST_ROLE_ARN`   | `arn:aws:iam::123456789012:role/HayaSendGitHubIntegration` | OIDC role              |
| `AWS_TEST_REGION`     | `ap-northeast-1`                                           | isolated test Region   |

No AWS access-key secret is required.

```bash
gh variable set AWS_TEST_ACCOUNT_ID \
  --env aws-integration \
  --body 123456789012
gh variable set AWS_TEST_ROLE_ARN \
  --env aws-integration \
  --body arn:aws:iam::123456789012:role/HayaSendGitHubIntegration
gh variable set AWS_TEST_REGION \
  --env aws-integration \
  --body ap-northeast-1
```

## AWS OIDC role

Create the GitHub OIDC provider with audience `sts.amazonaws.com`, then create
an assumable role. HayaSend was created after GitHub's immutable OIDC subject
rollout, so its current environment subject is:

```text
repo:haya-inc@259561228/hayasend@1312269309:environment:aws-integration
```

Use both audience and exact subject conditions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:haya-inc@259561228/hayasend@1312269309:environment:aws-integration"
        }
      }
    }
  ]
}
```

Confirm the current subject prefix before creating the role:

```bash
gh api repos/haya-inc/hayasend/actions/oidc/customization/sub
```

The role must be able to deploy and delete the resources in `template.yaml`,
use the SAM-managed artifact bucket, read the generated bootstrap secret,
create/describe/delete the exact synthetic integration log groups, and delete
retained integration S3/DynamoDB resources. Restore-proof runs additionally
need regional AWS Backup API access, `iam:PassRole` to the stack-created backup
roles for `backup.amazonaws.com`, and cleanup access to
`awsbackup-restore-test-*` buckets. Set the OIDC role's maximum session
duration to six hours; AWS Backup randomizes the start within the one-hour
restore-testing window and the workflow must not outlive its credentials.
Prefer a tightly scoped policy. If the first bootstrap uses administrator
access, do so only in the empty dedicated account, review CloudTrail after the
run, and replace it with a generated least-privilege policy before making the
workflow routine.

## Run and audit

After the workflow is on the default branch:

```bash
gh workflow run aws-integration.yml --ref main
gh run list --workflow aws-integration.yml --limit 1
```

Run the billable semantic restore proof after persistence changes and before a
production release that changes recovery behavior:

```bash
gh workflow run aws-integration.yml \
  --ref main \
  -f retain_stack=false \
  -f prove_backup_restore=true \
  -f prove_canary_rollback=true
```

The live check covers health, scoped keys, checksum-bound attachment upload,
schedule/reschedule/cancel, attachment privacy, suppressions, SES domain
identity operations, public webhook endpoint validation, webhook updates,
delivery-history queries, and webhook secret privacy.
It then deliberately removes the canceled schedule from the delivery path,
makes its durable outbox row due, invokes the deployed dispatcher, and proves
the row is acknowledged without a client replay or SES send.

After every run, confirm:

1. the workflow cleanup step passed;
2. the CloudFormation stack no longer exists;
3. no `it-<run-id>.example.com` SES identity remains;
4. no integration payload bucket or DynamoDB table remains;
5. for a restore proof, no `awsbackup-restore-test-*` table or bucket, recovery
   point, or ephemeral backup vault remains;
6. no `/hayasend/<integration-stack>/...` or synthetic legacy log group remains;
7. the exact `hayasend/<integration-stack>/` prefix and all of its versions are
   absent from the reusable SAM-managed artifact bucket.

Official references:

- [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [AWS credential action](https://github.com/aws-actions/configure-aws-credentials)
- [AWS SAM GitHub Actions](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/deploying-using-github.html)
- [SAM deploy reference](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-deploy.html)
- [SAM delete reference](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-delete.html)
- [CodeDeploy CloudWatch alarm monitoring](https://docs.aws.amazon.com/codedeploy/latest/userguide/monitoring-create-alarms.html)
- [CodeDeploy rollback information](https://docs.aws.amazon.com/codedeploy/latest/APIReference/API_RollbackInfo.html)
