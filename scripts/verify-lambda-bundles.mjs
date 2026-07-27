import { createRequire } from "node:module";
import { resolve } from "node:path";

const buildDirectory = resolve(process.argv[2] ?? ".aws-sam/build");
const require = createRequire(import.meta.url);

Object.assign(process.env, {
  AWS_REGION: "ap-northeast-1",
  HAYASEND_MODE: "aws",
  HAYASEND_API_KEY_SECRET_ARN:
    "arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:test",
  HAYASEND_TABLE_NAME: "hayasend-test",
  HAYASEND_QUEUE_URL:
    "https://sqs.ap-northeast-1.amazonaws.com/000000000000/hayasend-test",
  HAYASEND_QUEUE_ARN:
    "arn:aws:sqs:ap-northeast-1:000000000000:hayasend-test",
  HAYASEND_PAYLOAD_BUCKET: "hayasend-test",
  HAYASEND_CONFIGURATION_SET: "hayasend-test",
  HAYASEND_SCHEDULER_GROUP_NAME: "hayasend-test",
  HAYASEND_SCHEDULER_ROLE_ARN:
    "arn:aws:iam::000000000000:role/hayasend-test",
  HAYASEND_SCHEDULER_DLQ_ARN:
    "arn:aws:sqs:ap-northeast-1:000000000000:hayasend-test-dlq",
  HAYASEND_INBOUND_BUCKET: "hayasend-test-inbound",
});

const bundles = [
  ["ApiFunction", "api.cjs"],
  ["WorkerFunction", "worker.cjs"],
  ["DispatcherFunction", "dispatcher.cjs"],
  ["SesEventsFunction", "ses-events.cjs"],
  ["InboundFunction", "inbound.cjs"],
  ["LogRetentionFunction", "log-retention.cjs"],
];

for (const [functionName, fileName] of bundles) {
  const module = require(resolve(buildDirectory, functionName, fileName));
  if (typeof module.handler !== "function") {
    throw new TypeError(`${functionName} does not export a handler function.`);
  }
  process.stdout.write(`${functionName}: handler loaded\n`);
}
