import { startServer } from "./server.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function endpoint() {
  return (
    flag("endpoint") ??
    process.env.HAYASEND_BASE_URL ??
    "http://localhost:8787"
  ).replace(/\/$/, "");
}

function apiKey() {
  return flag("api-key") ?? process.env.HAYASEND_API_KEY ?? "re_hayasend_dev";
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${endpoint()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function doctor() {
  const health = await fetch(`${endpoint()}/healthz`);
  if (!health.ok) {
    throw new Error(`Health check failed with HTTP ${health.status}.`);
  }
  await request("/domains?limit=1");
  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: endpoint(),
        checks: {
          health: "pass",
          authentication: "pass",
        },
      },
      null,
      2,
    ),
  );
}

async function send() {
  const from = flag("from");
  const to = flag("to");
  const subject = flag("subject");
  const text = flag("text");
  if (!from || !to || !subject || !text) {
    throw new Error(
      "send requires --from, --to, --subject, and --text arguments.",
    );
  }
  const result = await request("/emails", {
    method: "POST",
    body: JSON.stringify({ from, to, subject, text }),
  });
  console.log(JSON.stringify(result, null, 2));
}

function help() {
  console.log(`HayaSend CLI

Commands:
  dev
  doctor [--endpoint URL] [--api-key KEY]
  send --from ADDRESS --to ADDRESS --subject TEXT --text TEXT
`);
}

async function main() {
  const command = process.argv[2] ?? "help";
  switch (command) {
    case "dev":
      startServer();
      break;
    case "doctor":
      await doctor();
      break;
    case "send":
      await send();
      break;
    default:
      help();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
