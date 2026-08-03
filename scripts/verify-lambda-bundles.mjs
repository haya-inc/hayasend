import { createRequire } from "node:module";
import { resolve } from "node:path";

const buildDirectory = resolve(process.argv[2] ?? ".aws-sam/build");
const require = createRequire(import.meta.url);

Object.assign(process.env, {
  AWS_REGION: "ap-northeast-1",
  HAYASEND_MODE: "aws",
  HAYASEND_API_KEY_SECRET_ARN:
    "arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:test",
  HAYASEND_CONSOLE_AUTH_ORIGIN: "https://console.example.com",
  HAYASEND_CONSOLE_AUTH_GOOGLE_CLIENT_ID:
    "test.apps.googleusercontent.com",
  HAYASEND_CONSOLE_AUTH_ALLOWED_EMAILS: "operator@example.com",
  HAYASEND_CONSOLE_AUTH_SECRET_ARN:
    "arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:console-auth",
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

const loadedBundles = new Map();
for (const [functionName, fileName] of bundles) {
  const module = require(resolve(buildDirectory, functionName, fileName));
  if (typeof module.handler !== "function") {
    throw new TypeError(`${functionName} does not export a handler function.`);
  }
  loadedBundles.set(functionName, module);
  process.stdout.write(`${functionName}: handler loaded\n`);
}

const createApiGatewayEvent = (rawPath) =>
  ({
    version: "2.0",
    routeKey: "GET /{proxy+}",
    rawPath,
    rawQueryString: "",
    headers: {
      host: "console.example.com",
      "x-forwarded-proto": "https",
    },
    requestContext: {
      accountId: "000000000000",
      apiId: "test",
      domainName: "console.example.com",
      domainPrefix: "console",
      http: {
        method: "GET",
        path: "/console",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "lambda-bundle-verifier",
      },
      requestId: "lambda-bundle-verifier",
      routeKey: "GET /{proxy+}",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 1_767_225_600_000,
    },
    isBase64Encoded: false,
  });

const apiHandler = loadedBundles.get("ApiFunction").handler;
const invokeApi = (rawPath) =>
  apiHandler(createApiGatewayEvent(rawPath), {
    awsRequestId: "lambda-bundle-verifier",
  });

const consoleResponse = await invokeApi("/console");

if (
  consoleResponse.statusCode !== 200 ||
  !consoleResponse.body?.includes('data-console-auth="better-auth"') ||
  !consoleResponse.body?.includes("Continue with Google")
) {
  throw new Error("The SAM-built operator console did not render correctly.");
}
process.stdout.write("ApiFunction: operator console rendered\n");

const consoleScriptResponse = await invokeApi("/console/app.js");
if (
  consoleScriptResponse.statusCode !== 200 ||
  !consoleScriptResponse.headers?.["content-type"]?.includes(
    "text/javascript",
  ) ||
  !consoleScriptResponse.body?.includes("HayaSendConsoleUI") ||
  consoleScriptResponse.body.includes("react-dom")
) {
  throw new Error("The SAM-built Hono JSX console client is invalid.");
}
process.stdout.write("ApiFunction: Hono JSX console client loaded\n");

const previewResponse = await invokeApi("/console/preview");
if (
  previewResponse.statusCode !== 200 ||
  !previewResponse.headers?.["content-security-policy"]?.includes(
    "script-src 'nonce-hayasend-preview-v1'",
  ) ||
  !previewResponse.body?.includes(
    "hayasend.operator-console.preview-ready.v1",
  )
) {
  throw new Error("The SAM-built sandboxed email preview is invalid.");
}
process.stdout.write("ApiFunction: sandboxed email preview loaded\n");
