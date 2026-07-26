# AWS cost model

Last verified: **2026-07-26**

HayaSend is consumption-priced and has no always-running server. The dominant
cost is normally Amazon SES, followed by CloudWatch logs, DynamoDB, and S3 at
higher volume. This guide separates the HayaSend infrastructure bill from SES
message charges and shows every modeled input so the estimate can be replaced
with an organization's own traffic.

These are illustrative USD list-price estimates before tax, contractual
discounts, AWS credits, or shared-account usage. They are not a quote. AWS can
change prices independently; rerun the model and check the linked official
pages before a deployment decision.

## Monthly examples

The `Persistent-free infrastructure` column applies only recurring,
service-specific allowances such as Lambda requests and duration, SQS and SNS
requests, EventBridge Scheduler invocations, DynamoDB's first 25 GiB of
Standard storage, and the documented CloudWatch allowances. It does not apply
introductory AWS credits. Those allowances are account-wide and may already be
consumed by other workloads, so list price is the safer budget ceiling.

| Workload | Region | Infrastructure list price | Persistent-free infrastructure | SES à la carte | Total, à la carte | SES Essentials | Total, Essentials |
|---|---|---:|---:|---:|---:|---:|---:|
| 10,000 messages | `us-east-1` | $4.05 | $0.19 | $1.00 | $1.19 | $1.60 | $1.79 |
| 10,000 messages | `ap-northeast-1` | $4.10 | $0.21 | $1.00 | $1.21 | $1.60 | $1.81 |
| 1,000,000 messages | `us-east-1` | $47.49 | $30.71 | $100.00 | $130.71 | $160.00 | $190.71 |
| 1,000,000 messages | `ap-northeast-1` | $53.55 | $34.61 | $100.00 | $134.61 | $160.00 | $194.61 |

The no-traffic list-price floor is primarily one $3 CloudWatch dashboard and
seven $0.10 standard-resolution alarm metrics. The recurring CloudWatch free
tier covers this checked-in configuration, but the model exposes list price so
an operator does not accidentally count the same account-wide allowance twice.

Amazon SES changed its entry pricing on 2026-07-21. New and long-inactive
accounts begin on Essentials, currently $0.16 per 1,000 messages for the first
10 million with no fixed monthly fee. À-la-carte outbound remains $0.10 per
1,000. Both add $0.12 per decimal GB of attachment data. The old 3,000-message,
12-month SES allowance continues only for eligible existing customers and is
not subtracted here.

## Workload assumptions

| Input | Light | Representative |
|---|---:|---:|
| Outbound recipient deliveries per month | 10,000 | 1,000,000 |
| Recipients per send | 1 | 1 |
| Rendered payload | 32 KiB | 32 KiB |
| SES notifications per delivery | 2 | 2 |
| Successful webhook endpoints | 1 | 1 |
| Events delivered to that webhook | 25% | 100% |
| Sends scheduled beyond 15 minutes | 1% | 5% |
| Lambda memory outside inbound processing | 256 MiB | 256 MiB |
| API / send worker / SES event / webhook duration | 100 / 300 / 100 / 200 ms | same |
| Application log output | 2 KiB per Lambda invocation | same |
| Modeled CloudWatch log retention | 30 days | 30 days |
| S3 payload retention | 45 days | 45 days |
| Webhook history retention | 7 days | 7 days |
| DynamoDB checkpoint | month 12 | month 12 |
| Attachments | none | none |
| Retries, bounces, complaints, opens, and clicks | excluded | excluded |
| Optional inbound Mail Manager | excluded | excluded |

The DynamoDB checkpoint matters because email metadata has no TTL and
accumulates. The model uses 2 KiB of durable metadata per message, 2 KiB per
temporarily retained webhook delivery, and 1 KiB per 24-hour idempotency
claim. Payload bodies use the checked-in 45-day S3 lifecycle.

Generated Lambda log groups currently use CloudWatch's no-expiration default.
The table deliberately models a 30-day operator retention policy. Without that
policy, archived log storage accumulates rather than reaching the modeled
steady state. Apply and audit log retention in the deployment account; never
reduce it below an incident-response or compliance requirement merely to
match this estimate.

## Recalculate

The checked-in model emits its assumptions, quantities, rates, free
allowances, and per-service line items as JSON:

```bash
npm run cost:estimate -- \
  --profile representative \
  --region ap-northeast-1 \
  --free-tier persistent \
  --ses a-la-carte
```

Substitute traffic without editing the script:

```bash
npm run cost:estimate -- \
  --region us-east-1 \
  --messages 250000 \
  --webhook-coverage 0.5 \
  --scheduled-fraction 0.02 \
  --message-kib 48 \
  --retained-months 18 \
  --log-kib-per-invocation 3
```

Model direct-upload attachments separately. This example attaches one 1 MiB
object to 10% of messages and includes S3 PUT, GET, 45-day storage, and SES
attachment-data charges:

```bash
npm run cost:estimate -- \
  --messages 1000000 \
  --attachment-share 0.1 \
  --attachment-mib 1
```

The calculator uses binary GiB for S3 and DynamoDB storage, matching their
storage-unit documentation, and decimal GB for SES attachment data, matching
the SES pricing examples.

The model intentionally supports only `us-east-1` and `ap-northeast-1`.
Adding another Region requires recording and reviewing each rate rather than
silently borrowing a nearby Region's price.

## Formulas

For `M` messages, `E=2` SES notifications per message, and webhook coverage
`W`, the model derives:

- HTTP API requests: `M`;
- webhook deliveries: `M × E × W`;
- Lambda invocations:
  `M API + M send workers + M × E SES handlers + webhook deliveries`;
- Lambda GiB-seconds: each invocation's assumed duration multiplied by
  0.25 GiB;
- DynamoDB write units:
  `6M + M × E + 3 × webhook deliveries`;
- DynamoDB read units:
  `5M + M × E + 3 × webhook deliveries`;
- SQS requests: three request units per send or webhook job, representing
  send, receive, and delete;
- Scheduler invocations: `M × scheduled fraction`;
- SNS requests: `M × E`; delivery from SNS to Lambda has no per-notification
  delivery charge;
- S3 storage:
  `(rendered payload + direct-upload attachments) × 45 / 30`;
- CloudWatch ingestion:
  `Lambda invocations × modeled log KiB`.

DynamoDB unit assumptions include the transactional create, send lease and
state transitions, provider-event state changes, and retained webhook
delivery state. Real item size, retries, extra recipients, API reads, batch
shape, webhook fan-out, and noisy logging can increase those quantities. Use
Cost Explorer and CloudWatch usage metrics after deployment to replace each
assumption with observed values.

## Optional inbound receiving

Inbound remains disabled by default. Enabling one public Mail Manager ingress
adds a material fixed cost even at zero traffic:

```text
Mail Manager =
  $50 per open ingress endpoint per month
  + inbound messages × $0.15 / 1,000
  + (inbound messages × average KiB / 256) × $0.09 / 1,000 chunks
```

HayaSend also creates one customer-managed KMS key, currently $1/month, plus
KMS requests; S3 storage and requests for raw MIME; a 1 GiB inbound Lambda;
DynamoDB metadata; webhook work; and CloudWatch logs. S3 Bucket Keys reduce
but do not make KMS request volume predictable, so obtain a separate AWS
Pricing Calculator estimate using the intended inbound size and retention.
Delete an unused open ingress endpoint—closing it does not stop its charge.

## Excluded costs

The checked-in stack creates no VPC, so the model has no NAT Gateway. It also
excludes:

- Route 53 hosted zones and DNS queries;
- cross-Region and internet data transfer;
- AWS Support plans and taxes;
- dedicated IPs, managed dedicated IPs, BYOIP, VDM, Global Endpoints,
  validation, tenants, and other SES add-ons;
- Mail Manager unless explicitly evaluated;
- CloudTrail data-event or third-party SIEM ingestion;
- backup exports, cross-Region backup copies, and disaster-recovery replicas;
- engineering, incident response, reputation management, and recipient-side
  deliverability work.

SES sandbox status, production access, and account sending quota are
prerequisites rather than line-item prices. Paying AWS or Haya support never
guarantees inbox placement.

## Official pricing sources

- [Amazon SES and Mail Manager](https://aws.amazon.com/ses/pricing/)
- [API Gateway](https://aws.amazon.com/api-gateway/pricing/)
- [Lambda](https://aws.amazon.com/lambda/pricing/)
- [DynamoDB](https://aws.amazon.com/dynamodb/pricing/)
- [SQS](https://aws.amazon.com/sqs/pricing/)
- [EventBridge Scheduler](https://aws.amazon.com/eventbridge/pricing/)
- [S3](https://aws.amazon.com/s3/pricing/)
- [KMS](https://aws.amazon.com/kms/pricing/)
- [SNS](https://aws.amazon.com/sns/pricing/)
- [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/)
- [AWS Pricing Calculator](https://calculator.aws/)

The regional rate snapshot in `scripts/aws-cost-model.mjs` was checked against
the AWS Price List API in `us-east-1` on the verification date. Review the
source diff whenever those constants change.
