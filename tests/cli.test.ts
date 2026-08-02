import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMainModule, normalizeEndpoint, runCli } from "../src/cli.js";
import {
  deploymentCapabilityDocument,
  deploymentCapabilityDocumentDigest,
} from "../src/deployment-capability-registry.js";
import {
  providerCapabilityDocumentDigest,
} from "../src/provider-capability-registry.js";
import {
  runtimeCapabilityDocument,
  runtimeCapabilityDocumentDigest,
} from "../src/runtime-capability-registry.js";
import { HAYASEND_VERSION } from "../src/version.js";

const temporaryDirectories: string[] = [];
const webhookTestSecret = `whsec_${"A".repeat(43)}=`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hayasend-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeTemplateProject(
  directory: string,
  overrides: Record<string, unknown> = {},
) {
  await writeFile(
    join(directory, "welcome.html"),
    "<p>Welcome, {{{NAME}}}</p>\n",
  );
  await writeFile(join(directory, "welcome.txt"), "Welcome, {{{NAME}}}\n");
  await writeFile(
    join(directory, "hayasend.templates.json"),
    JSON.stringify({
      version: 1,
      templates: [
        {
          alias: "welcome",
          name: "Welcome",
          html_file: "welcome.html",
          text_file: "welcome.txt",
          from: "Product <hello@example.com>",
          subject: "Welcome, {{{NAME}}}",
          variables: [
            {
              key: "NAME",
              type: "string",
              fallback_value: "friend",
            },
          ],
          ...overrides,
        },
      ],
    }),
  );
}

function remoteTemplate(overrides: Record<string, unknown> = {}) {
  return {
    object: "template",
    id: "tmpl_1234567890abcdef1234567890abcdef",
    current_version_id: "tmplv_1234567890abcdef1234567890abcdef",
    alias: "welcome",
    name: "Welcome",
    html: "<p>Welcome, {{{NAME}}}</p>\n",
    text: "Welcome, {{{NAME}}}\n",
    from: "Product <hello@example.com>",
    subject: "Welcome, {{{NAME}}}",
    reply_to: null,
    variables: [
      {
        id: "tmplvar_123",
        key: "NAME",
        type: "string",
        fallback_value: "friend",
        created_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
      },
    ],
    status: "published",
    has_unpublished_versions: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capturingIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    errors,
    logs,
    io: {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

describe("HayaSend CLI", () => {
  it("reports its exact packaged version through standard commands", async () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const capture = capturingIo();
      await runCli(args, { io: capture.io });
      expect(capture.logs).toEqual([HAYASEND_VERSION]);
      expect(capture.errors).toEqual([]);
    }
  });

  it("recognizes an npm-style symlink as the executable module", async () => {
    const directory = await temporaryDirectory();
    const modulePath = join(directory, "cli.js");
    const executablePath = join(directory, "hayasend");
    await writeFile(modulePath, "#!/usr/bin/env node\n");
    await symlink(modulePath, executablePath);

    const moduleUrl = pathToFileURL(modulePath).href;
    expect(isMainModule(executablePath, moduleUrl)).toBe(true);
    expect(isMainModule(undefined, moduleUrl)).toBe(false);
  });

  it("protects API keys from unsafe endpoint URLs", () => {
    expect(normalizeEndpoint("http://localhost:8787/")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeEndpoint("https://mail.example.com/api/")).toBe(
      "https://mail.example.com/api",
    );
    expect(() => normalizeEndpoint("http://mail.example.com")).toThrow(
      "Plain HTTP",
    );
    expect(() =>
      normalizeEndpoint("https://user:secret@mail.example.com"),
    ).toThrow("must not include credentials");
    expect(() =>
      normalizeEndpoint("https://mail.example.com?key=secret"),
    ).toThrow("query parameters");
  });

  it("rejects secret and unknown command-line options", async () => {
    await expect(
      runCli(["doctor", "--api-key", "re_secret"], {
        io: capturingIo().io,
      }),
    ).rejects.toThrow("Unknown option: --api-key");
    await expect(
      runCli(["doctor", "--endpont", "http://localhost:8787"], {
        io: capturingIo().io,
      }),
    ).rejects.toThrow("Unknown option: --endpont");
  });

  it("dispatches the Cloudflare Email Sending subscription doctor", async () => {
    const capture = capturingIo();
    const runCommand = vi.fn(async (_command: string, _args: string[]) => ({
      stdout: JSON.stringify([
        {
          id: "subscription-1234",
          name: "HayaSend terminal delivery",
          enabled: true,
          source: { type: "email.sending", domain: "hayasend.com" },
          destination: {
            type: "queues.queue",
            queue_id: "queue-1234",
          },
          events: [
            "message.delivered",
            "message.deferred",
            "message.bounced",
            "message.failed",
            "message.rejected",
            "message.complained",
          ],
        },
      ]),
      stderr: "",
      exitCode: 0,
    }));

    await runCli(
      [
        "doctor",
        "cloudflare-events",
        "--account",
        "a".repeat(32),
        "--name",
        "terminal-delivery",
        "--email-domain",
        "hayasend.com",
      ],
      {
        env: { CLOUDFLARE_API_TOKEN: "private-token" },
        io: capture.io,
        runCommand,
      },
    );

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]?.[1]).toContain("subscription");
    expect(JSON.parse(capture.logs.at(-1)!)).toMatchObject({
      object: "cloudflare_email_event_subscription_doctor",
      healthy: true,
    });
  });

  it("initializes a pinned, hardened setup without overwriting files", async () => {
    const directory = await temporaryDirectory();
    const capture = capturingIo();

    await runCli(["init"], {
      cwd: directory,
      io: capture.io,
    });

    const compose = await readFile(
      join(directory, "compose.hayasend.yaml"),
      "utf8",
    );
    expect(compose).toContain(
      `image: ghcr.io/haya-inc/hayasend:${HAYASEND_VERSION}`,
    );
    expect(compose).toContain('"127.0.0.1:8787:8787"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("- ALL");
    expect(compose).toContain("no-new-privileges:true");
    expect(
      await readFile(join(directory, ".env.hayasend.example"), "utf8"),
    ).toContain("HAYASEND_API_KEY=re_hayasend_dev");
    expect(
      (await stat(join(directory, "compose.hayasend.yaml"))).mode & 0o777,
    ).toBe(0o644);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      ok: true,
      directory,
      created: ["compose.hayasend.yaml", ".env.hayasend.example"],
    });

    await expect(
      runCli(["init"], { cwd: directory, io: capture.io }),
    ).rejects.toThrow("Refusing to overwrite");
    expect(
      await readFile(join(directory, "compose.hayasend.yaml"), "utf8"),
    ).toBe(compose);
  });

  it("refuses to initialize a filesystem root", async () => {
    await expect(
      runCli(["init", "--dir", "/"], {
        cwd: "/tmp",
        io: capturingIo().io,
      }),
    ).rejects.toThrow("filesystem root");
  });

  it("creates a scoped API key without printing its one-time token", async () => {
    const directory = await temporaryDirectory();
    const tokenPath = join(directory, "production-sender.token");
    const capture = capturingIo();
    const id = "key_1234567890abcdef1234567890abcdef";
    const token = `re_hs_${id}.${"A".repeat(43)}`;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://localhost:8787/api-keys");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer bootstrap-administrator-secret",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "production sender",
        scopes: ["emails:send", "emails:read"],
        expires_at: "2099-01-01T00:00:00.000Z",
      });
      return jsonResponse({
        id,
        name: "production sender",
        prefix: "re_hs_key_123456789…",
        scopes: ["emails:send", "emails:read"],
        created_at: "2026-07-26T00:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        token,
      });
    });

    await runCli(
      [
        "keys",
        "create",
        "--name",
        "production sender",
        "--scope",
        "emails:send",
        "--scope",
        "emails:read",
        "--scope",
        "emails:send",
        "--expires-at",
        "2099-01-01T00:00:00.000Z",
        "--token-out",
        tokenPath,
      ],
      {
        cwd: directory,
        env: { HAYASEND_API_KEY: "bootstrap-administrator-secret" },
        fetch: fetchMock,
        io: capture.io,
      },
    );

    expect(await readFile(tokenPath, "utf8")).toBe(token);
    if (process.platform !== "win32") {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
    const output = capture.logs[0] ?? "";
    expect(output).not.toContain(token);
    expect(output).not.toContain("bootstrap-administrator-secret");
    expect(JSON.parse(output)).toMatchObject({
      id,
      token_file: tokenPath,
      token_written: true,
    });
  });

  it("rejects secret-bearing or mismatched key creation metadata", async () => {
    const id = "key_1234567890abcdef1234567890abcdef";
    const otherId = "key_abcdef1234567890abcdef1234567890";
    const token = `re_hs_${otherId}.${"A".repeat(43)}`;
    const metadata = {
      id,
      name: "production sender",
      prefix: "re_hs_key_123456789…",
      scopes: ["emails:send"],
      created_at: "2026-07-26T00:00:00.000Z",
      token,
    };

    for (const response of [
      metadata,
      {
        ...metadata,
        token: `re_hs_${id}.${"A".repeat(43)}`,
        backup_token: token,
      },
    ]) {
      const directory = await temporaryDirectory();
      const tokenPath = join(directory, "rejected.token");
      const capture = capturingIo();
      await expect(
        runCli(
          [
            "keys",
            "create",
            "--name",
            "production sender",
            "--scope",
            "emails:send",
            "--token-out",
            tokenPath,
          ],
          {
            cwd: directory,
            fetch: vi.fn<typeof fetch>(async () => jsonResponse(response)),
            io: capture.io,
          },
        ),
      ).rejects.toThrow("valid API key and token");
      expect(capture.logs).toEqual([]);
      await expect(stat(tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("validates key creation and output conflicts before sending", async () => {
    const directory = await temporaryDirectory();
    const tokenPath = join(directory, "existing.token");
    await writeFile(tokenPath, "do-not-overwrite\n");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const dependencies = {
      cwd: directory,
      fetch: fetchMock,
      io: capturingIo().io,
    };

    await expect(
      runCli(
        ["keys", "create", "--name", "sender", "--scope", "emails:send"],
        dependencies,
      ),
    ).rejects.toThrow("requires --token-out");
    await expect(
      runCli(
        [
          "keys",
          "create",
          "--name",
          "sender",
          "--scope",
          "unknown:scope",
          "--token-out",
          "invalid.token",
        ],
        dependencies,
      ),
    ).rejects.toThrow("API key input is invalid");
    await expect(
      runCli(
        [
          "keys",
          "create",
          "--name",
          "sender",
          "--scope",
          "emails:send",
          "--expires-at",
          "2020-01-01T00:00:00.000Z",
          "--token-out",
          "expired.token",
        ],
        dependencies,
      ),
    ).rejects.toThrow("must be in the future");
    await expect(
      runCli(
        [
          "keys",
          "create",
          "--name",
          "sender",
          "--scope",
          "emails:send",
          "--token-out",
          parse(directory).root,
        ],
        dependencies,
      ),
    ).rejects.toThrow("filesystem root");
    await expect(
      runCli(
        [
          "keys",
          "create",
          "--name",
          "sender",
          "--scope",
          "emails:send",
          "--token-out",
          tokenPath,
        ],
        dependencies,
      ),
    ).rejects.toThrow("Refusing to overwrite");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(tokenPath, "utf8")).toBe("do-not-overwrite\n");
  });

  it("removes the reserved token file when key creation fails", async () => {
    const directory = await temporaryDirectory();
    const tokenPath = join(directory, "failed.token");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Try again later.",
        },
        503,
      ),
    );

    await expect(
      runCli(
        [
          "keys",
          "create",
          "--name",
          "sender",
          "--scope",
          "emails:send",
          "--token-out",
          tokenPath,
        ],
        { cwd: directory, fetch: fetchMock, io: capturingIo().io },
      ),
    ).rejects.toThrow("HTTP 503");
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists, inspects, and revokes API keys without returning tokens", async () => {
    const capture = capturingIo();
    const id = "key_1234567890abcdef1234567890abcdef";
    const metadata = {
      id,
      name: "production sender",
      prefix: "re_hs_key_123456789…",
      scopes: ["emails:send"],
      created_at: "2026-07-26T00:00:00.000Z",
    };
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const request = `${init?.method ?? "GET"} ${String(input)}`;
      requests.push(request);
      if (request.startsWith("DELETE")) {
        return jsonResponse({
          ...metadata,
          revoked_at: "2026-07-27T00:00:00.000Z",
          revoked: true,
        });
      }
      if (String(input).includes("?")) {
        return jsonResponse({ object: "list", data: [], has_more: false });
      }
      return jsonResponse(metadata);
    });

    await runCli(["keys", "list", "--limit", "10", "--after", id], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(["keys", "get", id], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(["keys", "revoke", id], {
      fetch: fetchMock,
      io: capture.io,
    });

    expect(requests).toEqual([
      `GET http://localhost:8787/api-keys?limit=10&after=${id}`,
      `GET http://localhost:8787/api-keys/${id}`,
      `DELETE http://localhost:8787/api-keys/${id}`,
    ]);
    expect(capture.logs.join("\n")).not.toContain("token");

    await expect(
      runCli(["keys", "get", "not-a-key"], {
        fetch: fetchMock,
        io: capture.io,
      }),
    ).rejects.toThrow("API key ID is invalid");
    await expect(
      runCli(["keys", "list", "--limit", "0"], {
        fetch: fetchMock,
        io: capture.io,
      }),
    ).rejects.toThrow("--limit must be an integer between 1 and 100");
    await expect(
      runCli(["keys", "list", "--after", "not-a-key"], {
        fetch: fetchMock,
        io: capture.io,
      }),
    ).rejects.toThrow("--after must be a valid API key ID");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never prints unexpected fields from key metadata endpoints", async () => {
    const id = "key_1234567890abcdef1234567890abcdef";
    const leakedToken = `re_hs_${id}.${"A".repeat(43)}`;
    const capture = capturingIo();

    await expect(
      runCli(["keys", "get", id], {
        fetch: vi.fn<typeof fetch>(async () =>
          jsonResponse({
            id,
            name: "production sender",
            prefix: "re_hs_key_123456789…",
            scopes: ["emails:send"],
            created_at: "2026-07-26T00:00:00.000Z",
            token: leakedToken,
          }),
        ),
        io: capture.io,
      }),
    ).rejects.toThrow("valid API key metadata");
    expect(capture.logs.join("\n")).not.toContain(leakedToken);
  });

  it("checks service identity, authentication, and preview availability", async () => {
    const capture = capturingIo();
    const requests: Array<{
      authorization: string | null;
      url: string;
    }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        url,
      });
      if (url.endsWith("/healthz")) {
        return jsonResponse({
          ok: true,
          service: "hayasend",
          version: "0.1.0",
        });
      }
      if (url.includes("/emails?limit=1")) {
        return jsonResponse({ object: "list", data: [] });
      }
      if (url.endsWith("/diagnostics/recovery")) {
        return jsonResponse({
          object: "recovery_diagnostics",
          generated_at: "2026-07-27T00:00:00.000Z",
          outbox: {
            due: 1,
            leased: 0,
            stuck_leases: 0,
            undispatched: 1,
            oldest_due_age_seconds: 12,
            publish_failures_total: 0,
            truncated: false,
          },
          queues: {
            provider: "memory",
            primary: {
              visible: 1,
              in_flight: 0,
              delayed: 0,
              total: 1,
            },
            dead_letters: {
              delivery: {
                visible: 0,
                in_flight: 0,
                delayed: 0,
                total: 0,
              },
              scheduler: {
                visible: 0,
                in_flight: 0,
                delayed: 0,
                total: 0,
              },
              inbound: null,
            },
          },
          provider_events: {
            latest_received_at: null,
            lag_seconds: null,
          },
          capability: {
            provider: "aws-ses",
            adapter_version: "0.3.7",
            capability_version: "1.0.0",
            checked_at: "2026-07-27",
            document_sha256: "a".repeat(64),
          },
          ignored_private_field:
            "recipient@example.net private body re_secret_token",
        });
      }
      return new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    await runCli(["doctor"], {
      env: {
        HAYASEND_BASE_URL: "http://localhost:8787",
        HAYASEND_API_KEY: "re_private_test_key",
      },
      fetch: fetchMock,
      io: capture.io,
    });

    expect(requests).toEqual([
      {
        authorization: null,
        url: "http://localhost:8787/healthz",
      },
      {
        authorization: "Bearer re_private_test_key",
        url: "http://localhost:8787/emails?limit=1",
      },
      {
        authorization: "Bearer re_private_test_key",
        url: "http://localhost:8787/diagnostics/recovery",
      },
      {
        authorization: null,
        url: "http://localhost:8787/preview",
      },
    ]);
    const output = capture.logs[0] ?? "";
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      checks: {
        health: "pass",
        identity: "pass",
        authentication: "pass",
        recovery: "pass",
        preview: "available",
      },
      recovery: {
        outbox: {
          oldest_due_age_seconds: 12,
        },
        capability: {
          drift: true,
        },
      },
    });
    expect(output).not.toContain("re_private_test_key");
    expect(output).not.toContain("recipient@example.net");
  });

  it.each([
    [
      "azure-communication-services",
      "portable-postgres",
      "azure-container-apps-acs",
    ],
    [
      "cloudflare-email",
      "cloudflare-native",
      "cloudflare-email",
    ],
    ["sendgrid", "vercel-serverless", "vercel-sendgrid"],
  ])(
    "verifies the bundled %s runtime and deployment capability digests",
    async (provider, runtime, deployment) => {
      const capture = capturingIo();
      const digest = providerCapabilityDocumentDigest(provider);
      const runtimeDocument = runtimeCapabilityDocument(runtime);
      const runtimeDigest = runtimeCapabilityDocumentDigest(runtime);
      const deploymentDocument =
        deploymentCapabilityDocument(deployment);
      const deploymentDigest =
        deploymentCapabilityDocumentDigest(deployment);
      let reportedDeploymentProvider =
        deploymentDocument?.transport.provider;
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(runtimeDocument).toBeDefined();
      expect(runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(deploymentDocument).toBeDefined();
      expect(deploymentDigest).toMatch(/^[a-f0-9]{64}$/);

      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/healthz")) {
          return jsonResponse({
            ok: true,
            service: "hayasend",
            version: HAYASEND_VERSION,
          });
        }
        if (url.includes("/emails?limit=1")) {
          return jsonResponse({ object: "list", data: [] });
        }
        if (url.endsWith("/diagnostics/recovery")) {
          return jsonResponse({
            object: "recovery_diagnostics",
            generated_at: "2026-07-29T00:00:00.000Z",
            outbox: {
              due: 0,
              leased: 0,
              stuck_leases: 0,
              undispatched: 0,
              oldest_due_age_seconds: 0,
              publish_failures_total: 0,
              truncated: false,
            },
            queues: {
              provider: "postgresql",
              primary: {
                visible: 0,
                in_flight: 0,
                delayed: 0,
                total: 0,
              },
              dead_letters: {
                delivery: null,
                scheduler: null,
                inbound: null,
              },
            },
            provider_events: {
              latest_received_at: null,
              lag_seconds: null,
            },
            capability: {
              provider,
              adapter_version: HAYASEND_VERSION,
              capability_version: "1.0.0",
              checked_at: "2026-07-29",
              document_sha256: digest,
            },
            runtime_capability: {
              runtime,
              adapter_version: runtimeDocument!.adapter_version,
              capability_version: runtimeDocument!.schema_version,
              checked_at: runtimeDocument!.checked_at,
              document_sha256: runtimeDigest,
            },
            deployment_capability: {
              deployment,
              adapter_version: deploymentDocument!.adapter_version,
              capability_version: deploymentDocument!.schema_version,
              checked_at: deploymentDocument!.checked_at,
              runtime: deploymentDocument!.runtime.profile,
              provider: reportedDeploymentProvider,
              maturity: deploymentDocument!.maturity.combination,
              production_ready:
                deploymentDocument!.production_ready,
              document_sha256: deploymentDigest,
            },
          });
        }
        return new Response(null, { status: 404 });
      });

      await runCli(["doctor"], {
        fetch: fetchMock,
        io: capture.io,
      });

      expect(JSON.parse(capture.logs[0] ?? "")).toMatchObject({
        ok: true,
        checks: { recovery: "pass" },
        recovery: {
          capability: {
            provider,
            drift: false,
          },
          runtime_capability: {
            runtime,
            drift: false,
          },
          deployment_capability: {
            deployment,
            drift: false,
          },
        },
      });
      if (provider === "sendgrid") {
        reportedDeploymentProvider = "aws-ses";
        const mismatchedCapture = capturingIo();
        await runCli(["doctor"], {
          fetch: fetchMock,
          io: mismatchedCapture.io,
        });
        expect(
          JSON.parse(mismatchedCapture.logs[0] ?? ""),
        ).toMatchObject({
          recovery: {
            deployment_capability: {
              deployment,
              drift: true,
            },
          },
        });
      }
    },
  );

  it("keeps existing doctor checks useful without diagnostics scope", async () => {
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/healthz")) {
        return jsonResponse({
          ok: true,
          service: "hayasend",
          version: "0.3.7",
        });
      }
      if (url.includes("/emails?limit=1")) {
        return jsonResponse({ object: "list", data: [] });
      }
      if (url.endsWith("/diagnostics/recovery")) {
        return jsonResponse(
          {
            name: "forbidden",
            message: "private policy detail must not be printed",
          },
          403,
        );
      }
      return new Response(null, { status: 404 });
    });

    await runCli(["doctor"], {
      fetch: fetchMock,
      io: capture.io,
    });

    const output = capture.logs[0] ?? "";
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      checks: {
        health: "pass",
        authentication: "pass",
        recovery: "not_authorized",
        preview: "not_available",
      },
    });
    expect(output).not.toContain("private policy detail");
  });

  it("rejects an endpoint that does not identify as HayaSend", async () => {
    await expect(
      runCli(["doctor"], {
        fetch: vi.fn<typeof fetch>(async () =>
          jsonResponse({ ok: true, service: "other" }),
        ),
        io: capturingIo().io,
      }),
    ).rejects.toThrow("did not identify itself as HayaSend");
  });

  it("does not echo a non-JSON endpoint response", async () => {
    const sensitive =
      "recipient@example.net private body re_secret_token https://user:pass@example.com";
    const operation = runCli(["doctor"], {
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(sensitive, {
            status: 502,
            headers: { "content-type": "text/plain" },
          }),
      ),
      io: capturingIo().io,
    });

    await expect(operation).rejects.toThrow(
      "Expected a JSON response from HayaSend (HTTP 502).",
    );
    await expect(operation).rejects.not.toThrow(sensitive);
  });

  it("sends and retrieves an explicit end-to-end test message", async () => {
    const capture = capturingIo();
    let subject = "";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/emails") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          subject: string;
        };
        subject = body.subject;
        expect(new Headers(init.headers).get("idempotency-key")).toMatch(
          /^hayasend-cli-/,
        );
        return jsonResponse({
          id: "email_1234567890abcdef1234567890abcdef",
        });
      }
      return jsonResponse({
        id: "email_1234567890abcdef1234567890abcdef",
        status: "sent",
        subject,
      });
    });

    await runCli(
      [
        "test",
        "--from",
        "sender@example.com",
        "--to",
        "recipient@example.net",
        "--subject",
        "CLI integration test",
      ],
      {
        env: {
          HAYASEND_BASE_URL: "http://127.0.0.1:8787",
          HAYASEND_API_KEY: "re_test",
        },
        fetch: fetchMock,
        io: capture.io,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      ok: true,
      email_id: "email_1234567890abcdef1234567890abcdef",
      status: "sent",
      preview_url:
        "http://127.0.0.1:8787/preview?email=email_1234567890abcdef1234567890abcdef",
    });
  });

  it("creates template drafts from a manifest without publishing by default", async () => {
    const directory = await temporaryDirectory();
    await writeTemplateProject(directory);
    const capture = capturingIo();
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const request = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method ?? "GET",
        url: String(input),
      };
      requests.push(request);
      if (
        request.method === "GET" &&
        request.url.endsWith("/templates/welcome")
      ) {
        return jsonResponse({ message: "Template was not found." }, 404);
      }
      return jsonResponse({
        object: "template",
        id: "tmpl_1234567890abcdef1234567890abcdef",
      });
    });

    await runCli(["templates", "push"], {
      cwd: directory,
      fetch: fetchMock,
      io: capture.io,
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: "http://localhost:8787/templates",
      body: {
        alias: "welcome",
        name: "Welcome",
        html: "<p>Welcome, {{{NAME}}}</p>\n",
        text: "Welcome, {{{NAME}}}\n",
        from: "Product <hello@example.com>",
        subject: "Welcome, {{{NAME}}}",
        reply_to: null,
        variables: [
          {
            key: "NAME",
            type: "string",
            fallback_value: "friend",
          },
        ],
      },
    });
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      ok: true,
      dry_run: false,
      publish: false,
      summary: {
        created: 1,
        updated: 0,
        published: 0,
        unchanged: 0,
      },
      templates: [
        {
          alias: "welcome",
          id: "tmpl_1234567890abcdef1234567890abcdef",
          actions: ["create"],
        },
      ],
    });
  });

  it("plans a publish without mutating anything during a dry run", async () => {
    const directory = await temporaryDirectory();
    await writeTemplateProject(directory);
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: "Template was not found." }, 404),
    );

    await runCli(["templates", "push", "--dry-run", "--publish"], {
      cwd: directory,
      fetch: fetchMock,
      io: capture.io,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      dry_run: true,
      publish: true,
      summary: { created: 1, published: 1 },
      templates: [
        {
          alias: "welcome",
          id: null,
          actions: ["create", "publish"],
        },
      ],
    });
  });

  it("updates drifted templates and publishes only when explicitly requested", async () => {
    const directory = await temporaryDirectory();
    await writeTemplateProject(directory);
    const capture = capturingIo();
    const requests: Array<{ method: string; url: string }> = [];
    let reads = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      requests.push({ method, url });
      if (method === "GET") {
        reads += 1;
        return jsonResponse(
          reads === 1
            ? remoteTemplate({
                subject: "An obsolete subject",
                has_unpublished_versions: true,
              })
            : remoteTemplate({
                current_version_id: "tmplv_abcdefabcdefabcdefabcdefabcdefab",
                has_unpublished_versions: true,
              }),
        );
      }
      if (url.endsWith("/publish")) {
        expect(new Headers(init?.headers).get("if-match")).toBe(
          '"tmplv_abcdefabcdefabcdefabcdefabcdefab"',
        );
      }
      return jsonResponse({
        object: "template",
        id: "tmpl_1234567890abcdef1234567890abcdef",
      });
    });

    await runCli(["templates", "push", "--publish"], {
      cwd: directory,
      fetch: fetchMock,
      io: capture.io,
    });

    expect(requests).toEqual([
      {
        method: "GET",
        url: "http://localhost:8787/templates/welcome",
      },
      {
        method: "PATCH",
        url:
          "http://localhost:8787/templates/" +
          "tmpl_1234567890abcdef1234567890abcdef",
      },
      {
        method: "GET",
        url: "http://localhost:8787/templates/welcome",
      },
      {
        method: "POST",
        url:
          "http://localhost:8787/templates/" +
          "tmpl_1234567890abcdef1234567890abcdef/publish",
      },
    ]);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      summary: { created: 0, updated: 1, published: 1 },
      templates: [{ alias: "welcome", actions: ["update", "publish"] }],
    });
  });

  it("does not write an unchanged published template", async () => {
    const directory = await temporaryDirectory();
    await writeTemplateProject(directory);
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(remoteTemplate()),
    );

    await runCli(["templates", "push", "--publish"], {
      cwd: directory,
      fetch: fetchMock,
      io: capture.io,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      summary: {
        created: 0,
        updated: 0,
        published: 0,
        unchanged: 1,
      },
    });
  });

  it("publishes an unchanged draft without creating another version", async () => {
    const directory = await temporaryDirectory();
    await writeTemplateProject(directory);
    const capture = capturingIo();
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse(
          remoteTemplate({
            status: "draft",
            has_unpublished_versions: false,
          }),
        );
      }
      return jsonResponse({
        object: "template",
        id: "tmpl_1234567890abcdef1234567890abcdef",
      });
    });

    await runCli(["templates", "push", "--publish"], {
      cwd: directory,
      fetch: fetchMock,
      io: capture.io,
    });

    expect(requests).toEqual([
      "GET http://localhost:8787/templates/welcome",
      "POST http://localhost:8787/templates/tmpl_1234567890abcdef1234567890abcdef/publish",
    ]);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      summary: { created: 0, updated: 0, published: 1 },
      templates: [{ alias: "welcome", actions: ["publish"] }],
    });
  });

  it("rejects manifest content files outside the manifest directory", async () => {
    const directory = await temporaryDirectory();
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(directory, "outside.html"), "<p>Outside</p>");
    await writeFile(
      join(project, "hayasend.templates.json"),
      JSON.stringify({
        version: 1,
        templates: [
          {
            alias: "escape",
            name: "Escape",
            html_file: "../outside.html",
          },
        ],
      }),
    );

    await expect(
      runCli(["templates", "push"], {
        cwd: project,
        fetch: vi.fn<typeof fetch>(),
        io: capturingIo().io,
      }),
    ).rejects.toThrow("must stay inside the manifest directory");
  });

  it("sends published templates with repeatable typed variables", async () => {
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        to: ["person@example.net"],
        template: {
          id: "welcome",
          variables: {
            NAME: "Ada",
            ORDER_ID: 42,
            ZIP: "00123",
          },
        },
      });
      return jsonResponse({
        id: "email_1234567890abcdef1234567890abcdef",
      });
    });

    await runCli(
      [
        "send",
        "--to",
        "person@example.net",
        "--template",
        "welcome",
        "--var",
        "NAME=Ada",
        "--var",
        "ORDER_ID=42",
        "--var",
        "ZIP=00123",
      ],
      { fetch: fetchMock, io: capture.io },
    );

    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual({
      id: "email_1234567890abcdef1234567890abcdef",
    });
  });

  it("lists, retrieves, renders, and explicitly publishes templates", async () => {
    const capture = capturingIo();
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).endsWith("/render")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          variables: { NAME: "Ada", ORDER_ID: 42 },
        });
      }
      if (String(input).endsWith("/publish")) {
        expect(new Headers(init?.headers).get("if-match")).toBe(
          '"tmplv_1234567890abcdef1234567890abcdef"',
        );
        expect(new Headers(init?.headers).get("x-hayasend-source")).toBe("cli");
      }
      return jsonResponse(
        init?.method === "POST"
          ? { object: "template", id: "tmpl_123" }
          : { object: "list", data: [] },
      );
    });

    await runCli(
      ["templates", "list", "--limit", "10", "--after", "tmpl_previous"],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["templates", "get", "welcome/one"], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(
      [
        "templates",
        "render",
        "welcome/one",
        "--var",
        "NAME=Ada",
        "--var",
        "ORDER_ID=42",
      ],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(
      [
        "templates",
        "publish",
        "welcome/one",
        "--version",
        "tmplv_1234567890abcdef1234567890abcdef",
      ],
      {
        fetch: fetchMock,
        io: capture.io,
      },
    );

    expect(requests).toEqual([
      "GET http://localhost:8787/templates?limit=10&after=tmpl_previous",
      "GET http://localhost:8787/templates/welcome%2Fone",
      "POST http://localhost:8787/templates/welcome%2Fone/render",
      "POST http://localhost:8787/templates/welcome%2Fone/publish",
    ]);
    await expect(
      runCli(
        [
          "templates",
          "list",
          "--after",
          "tmpl_after",
          "--before",
          "tmpl_before",
        ],
        { fetch: fetchMock, io: capture.io },
      ),
    ).rejects.toThrow("cannot be combined");
  });

  it("lists, inspects, renders, and safely restores historical template versions", async () => {
    const capture = capturingIo();
    const requests: string[] = [];
    const version = "tmplv_abcdefabcdefabcdefabcdefabcdefab";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "http://localhost:8787/templates/welcome") {
        return jsonResponse(remoteTemplate());
      }
      if (url.endsWith("/restore")) {
        expect(new Headers(init?.headers).get("if-match")).toBe(
          '"tmplv_1234567890abcdef1234567890abcdef"',
        );
        return jsonResponse({
          object: "template_restore",
          template_id: "tmpl_1234567890abcdef1234567890abcdef",
          source_version_id: version,
          current_version_id: "tmplv_11111111111111111111111111111111",
        });
      }
      if (url.endsWith("/render")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          variables: { NAME: "Ada" },
        });
        return jsonResponse({
          object: "template_render",
          template_id: "tmpl_1234567890abcdef1234567890abcdef",
          version_id: version,
          html: "<p>Ada</p>",
          text: "Ada",
        });
      }
      return jsonResponse(
        url.includes("?limit=")
          ? { object: "list", data: [], has_more: false }
          : { object: "template_version", id: version },
      );
    });

    await runCli(
      ["templates", "versions", "welcome", "--limit", "10", "--after", version],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["templates", "inspect-version", "welcome", version], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(
      ["templates", "render-version", "welcome", version, "--var", "NAME=Ada"],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["templates", "restore-version", "welcome", version], {
      fetch: fetchMock,
      io: capture.io,
    });

    expect(requests).toEqual([
      `GET http://localhost:8787/templates/welcome/versions?limit=10&after=${version}`,
      `GET http://localhost:8787/templates/welcome/versions/${version}`,
      `POST http://localhost:8787/templates/welcome/versions/${version}/render`,
      "GET http://localhost:8787/templates/welcome",
      `POST http://localhost:8787/templates/welcome/versions/${version}/restore`,
    ]);
    await expect(
      runCli(["templates", "restore-version", "welcome", "not-a-version"], {
        fetch: fetchMock,
        io: capture.io,
      }),
    ).rejects.toThrow("version ID is invalid");
  });

  it("creates a webhook without printing its one-time signing secret", async () => {
    const directory = await temporaryDirectory();
    const capture = capturingIo();
    const secretPath = join(directory, "webhook.secret");
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://localhost:8787/webhooks");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        endpoint: "https://hooks.example.com/email",
        events: ["email.sent", "email.bounced"],
      });
      return jsonResponse({
        object: "webhook",
        id: "wh_11111111111111111111111111111111",
        endpoint: "https://hooks.example.com/email",
        events: ["email.sent", "email.bounced"],
        status: "enabled",
        signing_secret: webhookTestSecret,
        backup_signing_secret: "whsec_also_do_not_log",
      });
    });

    await runCli(
      [
        "webhooks",
        "create",
        "--url",
        "https://hooks.example.com/email",
        "--event",
        "email.sent",
        "--event",
        "email.sent",
        "--event",
        "email.bounced",
        "--secret-file",
        "webhook.secret",
      ],
      {
        cwd: directory,
        fetch: fetchMock,
        io: capture.io,
      },
    );

    expect(await readFile(secretPath, "utf8")).toBe(`${webhookTestSecret}\n`);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    expect(capture.logs.join("\n")).not.toContain(webhookTestSecret);
    expect(capture.logs.join("\n")).not.toContain("whsec_also_do_not_log");
    expect(capture.errors.join("\n")).not.toContain(webhookTestSecret);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      object: "webhook",
      id: "wh_11111111111111111111111111111111",
      signing_secret_file: secretPath,
    });
  });

  it("refuses existing webhook secret files before contacting HayaSend", async () => {
    const directory = await temporaryDirectory();
    const secretPath = join(directory, "webhook.secret");
    await writeFile(secretPath, "keep me\n", { mode: 0o600 });
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      runCli(
        [
          "webhooks",
          "create",
          "--url",
          "https://hooks.example.com/email",
          "--event",
          "email.sent",
          "--secret-file",
          secretPath,
        ],
        {
          cwd: directory,
          fetch: fetchMock,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow("Refusing to overwrite signing secret file");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(secretPath, "utf8")).toBe("keep me\n");
  });

  it("cleans an empty secret reservation and redacts error responses", async () => {
    const directory = await temporaryDirectory();
    const secretPath = join(directory, "webhook.secret");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          message: "Rejected",
          details: {
            signingSecret: "whsec_error_leak",
          },
        },
        400,
      ),
    );

    let failure: unknown;
    try {
      await runCli(
        [
          "webhooks",
          "create",
          "--url",
          "https://hooks.example.com/email",
          "--event",
          "email.sent",
          "--secret-file",
          secretPath,
        ],
        {
          cwd: directory,
          fetch: fetchMock,
          io: capturingIo().io,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[REDACTED]");
    expect((failure as Error).message).not.toContain("whsec_error_leak");
    await expect(access(secretPath)).rejects.toThrow();
  });

  it("removes a newly created webhook if its signing secret cannot be saved", async () => {
    const directory = await temporaryDirectory();
    const secretPath = join(directory, "webhook.secret");
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "DELETE") {
        return jsonResponse({
          object: "webhook",
          id: "wh_22222222222222222222222222222222",
          deleted: true,
        });
      }
      return jsonResponse({
        object: "webhook",
        id: "wh_22222222222222222222222222222222",
        endpoint: "https://hooks.example.com/email",
        events: ["email.sent"],
        status: "enabled",
      });
    });

    await expect(
      runCli(
        [
          "webhooks",
          "create",
          "--url",
          "https://hooks.example.com/email",
          "--event",
          "email.sent",
          "--secret-file",
          secretPath,
        ],
        {
          cwd: directory,
          fetch: fetchMock,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow("did not return a valid webhook signing secret");

    expect(requests).toEqual([
      "POST http://localhost:8787/webhooks",
      "DELETE http://localhost:8787/webhooks/wh_22222222222222222222222222222222",
    ]);
    await expect(access(secretPath)).rejects.toThrow();
  });

  it("manages webhooks and retained deliveries with encoded identifiers", async () => {
    const capture = capturingIo();
    const requests: Array<{
      body: unknown;
      method: string;
      url: string;
    }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method: init?.method ?? "GET",
        url: String(input),
      });
      return jsonResponse({ ok: true });
    });

    await runCli(
      [
        "webhooks",
        "list",
        "--limit",
        "10",
        "--after",
        "wh_11111111111111111111111111111111",
      ],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["webhooks", "get", "wh/one"], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(
      [
        "webhooks",
        "update",
        "wh/one",
        "--url",
        "https://hooks.example.com/new",
        "--event",
        "email.sent",
        "--event",
        "email.sent",
        "--status",
        "disabled",
      ],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["webhooks", "delete", "wh/one", "--yes"], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(
      [
        "webhooks",
        "deliveries",
        "wh/one",
        "--limit",
        "25",
        "--after",
        "msg_22222222222222222222222222222222",
      ],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["webhooks", "inspect-delivery", "wh/one", "whd/two"], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(["webhooks", "replay", "wh/one", "whd/two", "--yes"], {
      fetch: fetchMock,
      io: capture.io,
    });

    expect(requests).toEqual([
      {
        body: null,
        method: "GET",
        url: "http://localhost:8787/webhooks?limit=10&after=wh_11111111111111111111111111111111",
      },
      {
        body: null,
        method: "GET",
        url: "http://localhost:8787/webhooks/wh%2Fone",
      },
      {
        body: {
          endpoint: "https://hooks.example.com/new",
          events: ["email.sent"],
          status: "disabled",
        },
        method: "PATCH",
        url: "http://localhost:8787/webhooks/wh%2Fone",
      },
      {
        body: null,
        method: "DELETE",
        url: "http://localhost:8787/webhooks/wh%2Fone",
      },
      {
        body: null,
        method: "GET",
        url: "http://localhost:8787/webhooks/wh%2Fone/deliveries?limit=25&after=msg_22222222222222222222222222222222",
      },
      {
        body: null,
        method: "GET",
        url: "http://localhost:8787/webhooks/wh%2Fone/deliveries/whd%2Ftwo",
      },
      {
        body: null,
        method: "POST",
        url: "http://localhost:8787/webhooks/wh%2Fone/deliveries/whd%2Ftwo/replay",
      },
    ]);
  });

  it("validates webhook events, pagination, updates, and acknowledgements locally", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const dependencies = {
      fetch: fetchMock,
      io: capturingIo().io,
    };

    await expect(
      runCli(
        [
          "webhooks",
          "create",
          "--url",
          "https://hooks.example.com/email",
          "--event",
          "email.unknown",
          "--secret-file",
          "unused.secret",
        ],
        dependencies,
      ),
    ).rejects.toThrow("Unsupported webhook event");
    await expect(
      runCli(
        [
          "webhooks",
          "create",
          "--url",
          "https://user:password@hooks.example.com/email",
          "--event",
          "email.sent",
          "--secret-file",
          "unused.secret",
        ],
        dependencies,
      ),
    ).rejects.toThrow("without credentials");
    await expect(
      runCli(["webhooks", "list", "--limit", "101"], dependencies),
    ).rejects.toThrow("between 1 and 100");
    await expect(
      runCli(["webhooks", "list", "--after", "not-a-webhook"], dependencies),
    ).rejects.toThrow("valid webhook ID");
    await expect(
      runCli(
        ["webhooks", "deliveries", "wh_123", "--after", "not-a-delivery"],
        dependencies,
      ),
    ).rejects.toThrow("valid delivery ID");
    await expect(
      runCli(["webhooks", "update", "wh_123"], dependencies),
    ).rejects.toThrow("at least one");
    await expect(
      runCli(["webhooks", "delete", "wh_123"], dependencies),
    ).rejects.toThrow("requires --yes");
    await expect(
      runCli(["webhooks", "replay", "wh_123", "msg_123"], dependencies),
    ).rejects.toThrow("requires --yes");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds only normalized manual suppressions with bounded detail files", async () => {
    const directory = await temporaryDirectory();
    const detailPath = join(directory, "suppression-detail.txt");
    await writeFile(detailPath, "Consent request SUP-123\n");
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://localhost:8787/suppressions");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        email: "blocked@example.net",
        reason: "manual",
        detail: "Consent request SUP-123",
      });
      return jsonResponse({
        id: "suppression_hash",
        email: "blocked@example.net",
        reason: "manual",
      });
    });

    await runCli(
      [
        "suppressions",
        "add",
        "Blocked User <Blocked@Example.NET>",
        "--detail-file",
        detailPath,
      ],
      {
        cwd: directory,
        fetch: fetchMock,
        io: capture.io,
      },
    );

    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual({
      id: "suppression_hash",
      email: "blocked@example.net",
      reason: "manual",
    });
  });

  it("lists, retrieves, and explicitly deletes suppressions", async () => {
    const directory = await temporaryDirectory();
    const emailPath = join(directory, "suppression-email.txt");
    await writeFile(emailPath, "User+Tag@Example.NET\n");
    const capture = capturingIo();
    const cursor = "a".repeat(64);
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
      });
      return jsonResponse({ ok: true });
    });

    await runCli(["suppressions", "list", "--limit", "10", "--after", cursor], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(["suppressions", "get", "--email-file", emailPath], {
      cwd: directory,
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(
      ["suppressions", "delete", "--email-file", emailPath, "--yes"],
      {
        cwd: directory,
        fetch: fetchMock,
        io: capture.io,
      },
    );

    expect(requests).toEqual([
      {
        method: "GET",
        url: `http://localhost:8787/suppressions?limit=10&after=${cursor}`,
      },
      {
        method: "GET",
        url: "http://localhost:8787/suppressions/user%2Btag%40example.net",
      },
      {
        method: "DELETE",
        url: "http://localhost:8787/suppressions/user%2Btag%40example.net",
      },
    ]);
  });

  it("validates suppression inputs before contacting HayaSend", async () => {
    const directory = await temporaryDirectory();
    const emailPath = join(directory, "suppression-email.txt");
    const detailPath = join(directory, "suppression-detail.txt");
    const largeEmailPath = join(directory, "large-email.txt");
    const largeDetailPath = join(directory, "large-detail.txt");
    const invalidUtf8Path = join(directory, "invalid-utf8.txt");
    await writeFile(emailPath, "blocked@example.net\n");
    await writeFile(detailPath, "x".repeat(501));
    await writeFile(largeEmailPath, "x".repeat(1_025));
    await writeFile(largeDetailPath, "x".repeat(2_049));
    await writeFile(invalidUtf8Path, Buffer.from([0xff]));
    const fetchMock = vi.fn<typeof fetch>();
    const dependencies = {
      cwd: directory,
      fetch: fetchMock,
      io: capturingIo().io,
    };

    await expect(
      runCli(
        [
          "suppressions",
          "add",
          "blocked@example.net",
          "--email-file",
          emailPath,
        ],
        dependencies,
      ),
    ).rejects.toThrow("not both");
    await expect(
      runCli(["suppressions", "get", "not-an-email"], dependencies),
    ).rejects.toThrow("mailbox is invalid");
    await expect(
      runCli(
        [
          "suppressions",
          "add",
          "blocked@example.net",
          "--detail-file",
          detailPath,
        ],
        dependencies,
      ),
    ).rejects.toThrow("between 1 and 500");
    await expect(
      runCli(
        ["suppressions", "get", "--email-file", largeEmailPath],
        dependencies,
      ),
    ).rejects.toThrow("exceeds 1024 bytes");
    await expect(
      runCli(
        [
          "suppressions",
          "add",
          "blocked@example.net",
          "--detail-file",
          largeDetailPath,
        ],
        dependencies,
      ),
    ).rejects.toThrow("exceeds 2048 bytes");
    await expect(
      runCli(
        ["suppressions", "get", "--email-file", invalidUtf8Path],
        dependencies,
      ),
    ).rejects.toThrow("valid UTF-8");
    await expect(
      runCli(["suppressions", "list", "--limit", "0"], dependencies),
    ).rejects.toThrow("between 1 and 100");
    await expect(
      runCli(["suppressions", "list", "--after", "not-an-id"], dependencies),
    ).rejects.toThrow("valid suppression ID");
    await expect(
      runCli(
        ["suppressions", "add", "blocked@example.net", "--reason", "bounce"],
        dependencies,
      ),
    ).rejects.toThrow("Unknown option: --reason");
    await expect(
      runCli(
        ["suppressions", "get", "blocked@example.net", "--api-key", "secret"],
        dependencies,
      ),
    ).rejects.toThrow("Unknown option: --api-key");
    await expect(
      runCli(
        [
          "suppressions",
          "get",
          "--email-file",
          emailPath,
          "--email-file",
          emailPath,
        ],
        dependencies,
      ),
    ).rejects.toThrow("may be provided only once");
    await expect(
      runCli(["suppressions", "delete", "blocked@example.net"], dependencies),
    ).rejects.toThrow("requires --yes");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires one regular mailbox input file", async () => {
    const directory = await temporaryDirectory();
    const regularPath = join(directory, "recipient.txt");
    const symlinkPath = join(directory, "recipient-link.txt");
    await writeFile(regularPath, "blocked@example.net\n");
    await symlink(regularPath, symlinkPath);
    const fetchMock = vi.fn<typeof fetch>();
    const dependencies = {
      cwd: directory,
      fetch: fetchMock,
      io: capturingIo().io,
    };

    await expect(runCli(["suppressions", "get"], dependencies)).rejects.toThrow(
      "argument or --email-file is required",
    );
    await expect(
      runCli(["suppressions", "get", "--email-file", directory], dependencies),
    ).rejects.toThrow("must be a regular file");
    await expect(
      runCli(
        ["suppressions", "get", "--email-file", symlinkPath],
        dependencies,
      ),
    ).rejects.toThrow("must be a regular file");
    await expect(
      runCli(
        [
          "suppressions",
          "add",
          "blocked@example.net",
          "--detail-file",
          symlinkPath,
        ],
        dependencies,
      ),
    ).rejects.toThrow("must be a regular file");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists and retrieves privacy-safe email summaries by default", async () => {
    const capture = capturingIo();
    const emailId = `email_${"1".repeat(32)}`;
    const nextCursor = `email_${"2".repeat(32)}`;
    const previousCursor = `email_${"3".repeat(32)}`;
    const record = {
      object: "email",
      id: emailId,
      from: "Founder <founder@example.com>",
      to: ["customer@example.net"],
      cc: ["finance@example.com"],
      bcc: ["audit@example.com"],
      reply_to: ["support@example.com"],
      subject: "Private acquisition",
      html: "<p>Confidential terms</p>",
      text: "Confidential terms",
      headers: { "x-private-case": "merger-42" },
      tags: [{ name: "account", value: "customer-7" }],
      attachments: [{ filename: "cap-table.pdf" }],
      status: "scheduled",
      last_event: "scheduled",
      scheduled_at: "2030-01-02T00:00:00.000Z",
      provider_id: "provider_opaque",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:01:00.000Z",
    };
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      requests.push(String(input));
      return jsonResponse(
        String(input).includes("?")
          ? {
              object: "list",
              data: [record],
              has_more: true,
              next_cursor: nextCursor,
              internal_note: "must not be copied",
            }
          : record,
      );
    });

    await runCli(
      ["emails", "list", "--limit", "20", "--after", previousCursor],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["emails", "get", emailId], {
      fetch: fetchMock,
      io: capture.io,
    });

    const expectedSummary = {
      object: "email_summary",
      id: emailId,
      status: "scheduled",
      last_event: "scheduled",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:01:00.000Z",
      scheduled_at: "2030-01-02T00:00:00.000Z",
      provider_id: "provider_opaque",
      recipient_count: 3,
      attachment_count: 1,
      has_content: true,
    };
    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual({
      object: "list",
      data: [expectedSummary],
      has_more: true,
      next_cursor: nextCursor,
    });
    expect(JSON.parse(capture.logs[1] ?? "{}")).toEqual(expectedSummary);
    expect(capture.logs.join("\n")).not.toContain("founder@example.com");
    expect(capture.logs.join("\n")).not.toContain("customer@example.net");
    expect(capture.logs.join("\n")).not.toContain("Private acquisition");
    expect(capture.logs.join("\n")).not.toContain("Confidential terms");
    expect(capture.logs.join("\n")).not.toContain("cap-table.pdf");
    expect(capture.logs.join("\n")).not.toContain("merger-42");
    expect(capture.logs.join("\n")).not.toContain("customer-7");
    expect(capture.logs.join("\n")).not.toContain("must not be copied");
    expect(requests).toEqual([
      `http://localhost:8787/emails?limit=20&after=${previousCursor}`,
      `http://localhost:8787/emails/${emailId}`,
    ]);
  });

  it("prints only allowlisted recipient recovery fields", async () => {
    const capture = capturingIo();
    const emailId = `email_${"7".repeat(32)}`;
    const recipientId = `rcpt_${"8".repeat(32)}`;
    const previousCursor = `rcpt_${"9".repeat(32)}`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        object: "list",
        message_id: emailId,
        aggregate_status: "bounced",
        recipient_count: 2,
        attempt_summary: {
          pending: 0,
          submitting: 0,
          accepted: 1,
          ambiguous: 0,
          retryable_failed: 0,
          permanent_failed: 0,
        },
        unattributed_event_count: 0,
        data: [
          {
            id: recipientId,
            role: "to",
            ordinal: 0,
            status: "bounced",
            recovery_state: "settled",
            requires_operator_attention: true,
            latest_attempt: {
              id: `attempt_${"a".repeat(32)}`,
              sequence: 1,
              status: "accepted",
              diagnostic_category: null,
              started_at: "2030-01-01T00:00:00.000Z",
              completed_at: "2030-01-01T00:00:01.000Z",
              provider_message_id: "private-provider-id",
            },
            updated_at: "2030-01-01T00:00:02.000Z",
            address: "private-recipient@example.net",
            raw_provider_error: "private SMTP response",
          },
        ],
        has_more: false,
        internal_subject: "Private subject",
      }),
    );

    await runCli(
      [
        "emails",
        "recipients",
        emailId,
        "--limit",
        "1",
        "--after",
        previousCursor,
      ],
      { fetch: fetchMock, io: capture.io },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:8787/emails/${emailId}/recipients?limit=1&after=${previousCursor}`,
      expect.any(Object),
    );
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      object: "list",
      message_id: emailId,
      aggregate_status: "bounced",
      data: [
        {
          id: recipientId,
          status: "bounced",
          recovery_state: "settled",
          requires_operator_attention: true,
          latest_attempt: {
            status: "accepted",
          },
        },
      ],
    });
    const output = capture.logs.join("\n");
    expect(output).not.toContain("private-recipient@example.net");
    expect(output).not.toContain("Private subject");
    expect(output).not.toContain("private SMTP response");
    expect(output).not.toContain("private-provider-id");
  });

  it("reveals a complete email record only with an explicit flag", async () => {
    const capture = capturingIo();
    const record = {
      id: `email_${"4".repeat(32)}`,
      from: "sender@example.com",
      to: ["recipient@example.net"],
      subject: "Sensitive subject",
      text: "Sensitive body",
      status: "sent",
      last_event: "sent",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:01:00.000Z",
    };

    await runCli(["emails", "get", record.id, "--include-content"], {
      fetch: vi.fn<typeof fetch>(async () => jsonResponse(record)),
      io: capture.io,
    });

    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual(record);
  });

  it("cancels and reschedules valid email IDs only after confirmation", async () => {
    const capture = capturingIo();
    const emailId = `email_${"5".repeat(32)}`;
    const requests: Array<{
      url: string;
      method: string;
      body: unknown;
    }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({
        id: emailId,
        recipient: "must-not-be-printed@example.net",
      });
    });
    const future = new Date(Date.now() + 86_400_000)
      .toISOString()
      .replace("Z", "+00:00");

    await runCli(["emails", "cancel", emailId, "--yes"], {
      fetch: fetchMock,
      io: capture.io,
    });
    await runCli(
      ["emails", "update", emailId, "--scheduled-at", future, "--yes"],
      { fetch: fetchMock, io: capture.io },
    );

    expect(requests).toEqual([
      {
        url: `http://localhost:8787/emails/${emailId}/cancel`,
        method: "POST",
        body: undefined,
      },
      {
        url: `http://localhost:8787/emails/${emailId}`,
        method: "PATCH",
        body: { scheduled_at: new Date(future).toISOString() },
      },
    ]);
    expect(capture.logs.map((entry) => JSON.parse(entry))).toEqual([
      { id: emailId },
      { id: emailId },
    ]);
    expect(capture.logs.join("\n")).not.toContain("must-not-be-printed");
  });

  it("fails closed before printing unsafe response metadata", async () => {
    const capture = capturingIo();
    const emailId = `email_${"6".repeat(32)}`;
    const record = {
      id: emailId,
      to: ["recipient@example.net"],
      status: "failed",
      last_event: "failed",
      error: "Mailbox recipient@example.net was rejected",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:01:00.000Z",
    };

    await expect(
      runCli(["emails", "get", emailId], {
        fetch: vi.fn<typeof fetch>(async () => jsonResponse(record)),
        io: capture.io,
      }),
    ).rejects.toThrow("invalid email record");

    expect(capture.logs).toEqual([]);
  });

  it("rejects unsafe email lifecycle arguments before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const io = capturingIo().io;

    await expect(
      runCli(["emails", "cancel", "email_queued"], {
        fetch: fetchMock,
        io,
      }),
    ).rejects.toThrow("requires --yes");
    await expect(
      runCli(
        [
          "emails",
          "update",
          "email_queued",
          "--scheduled-at",
          "yesterday",
          "--yes",
        ],
        { fetch: fetchMock, io },
      ),
    ).rejects.toThrow("scheduled_at");
    await expect(
      runCli(["emails", "list", "--limit", "101"], {
        fetch: fetchMock,
        io,
      }),
    ).rejects.toThrow("1 to 100");
    await expect(
      runCli(["emails", "list", "--after", "not-an-email-id"], {
        fetch: fetchMock,
        io,
      }),
    ).rejects.toThrow("valid HayaSend email ID");
    await expect(
      runCli(["emails", "get", "not-an-email-id"], {
        fetch: fetchMock,
        io,
      }),
    ).rejects.toThrow("valid HayaSend email ID");
    await expect(
      runCli(["emails", "get", "--include-content"], {
        fetch: fetchMock,
        io,
      }),
    ).rejects.toThrow("Email ID is required");
    await expect(
      runCli(["emails", "list", "--include-content"], {
        fetch: fetchMock,
        io,
      }),
    ).rejects.toThrow("Unknown option");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
