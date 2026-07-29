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

The workflow sets `WorkerReservedConcurrency=0` so a newly created account can
use its unreserved Lambda concurrency pool without weakening the production
default of 10 reserved worker executions.

## Safety boundary

Use an AWS account that contains no production resources or data. Enable an
AWS Budget and root-account alerts before the first run. The workflow:

- authenticates with GitHub OIDC and stores no long-lived AWS key;
- fails if STS returns an account other than `AWS_TEST_ACCOUNT_ID`;
- runs through the protected `aws-integration` GitHub environment;
- creates a unique CloudFormation stack per run;
- proves the required two-phase Lambda rollout by creating aliases first and
  enabling alarm-driven CodeDeploy deployment groups on the reviewed update;
- sends no email to SES;
- cancels every test schedule and deletes its temporary SES identity;
- deletes the synthetic legacy and stack-owned CloudWatch log groups;
- explicitly acknowledges termination-protection disable, deletes the stack
  through `cleanup aws`, then deletes the S3 bucket and DynamoDB table retained
  by HayaSend's production-safe deletion policies.

Cleanup allows up to 60 seconds for CloudWatch's post-stack deletion view to
converge. A stack-owned group still visible after that bound is reported,
deleted to leave the account clean, and treated as a failed run.

The `retain_stack` input defaults to false. Enable it only for active
debugging, and delete the retained resources immediately afterward.

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
retained integration S3/DynamoDB resources. Prefer a tightly scoped policy. If
the first bootstrap uses administrator access, do so only in the empty
dedicated account, review CloudTrail after the run, and replace it with a
generated least-privilege policy before making the workflow routine.

## Run and audit

After the workflow is on the default branch:

```bash
gh workflow run aws-integration.yml --ref main
gh run list --workflow aws-integration.yml --limit 1
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
5. no `/hayasend/<integration-stack>/...` or synthetic legacy log group remains;
6. the SAM-managed artifact bucket contains no unexpected old artifacts.

Official references:

- [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [AWS credential action](https://github.com/aws-actions/configure-aws-credentials)
- [AWS SAM GitHub Actions](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/deploying-using-github.html)
- [SAM deploy reference](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-deploy.html)
- [SAM delete reference](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-delete.html)
