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
    expect(compose).toContain("image: ghcr.io/haya-inc/hayasend:0.1.0");
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
      { ...metadata, token: `re_hs_${id}.${"A".repeat(43)}`, backup_token: token },
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
        [
          "keys",
          "create",
          "--name",
          "sender",
          "--scope",
          "emails:send",
        ],
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
        preview: "available",
      },
    });
    expect(output).not.toContain("re_private_test_key");
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
      fetch: vi.fn<typeof fetch>(async () =>
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
        to: "person@example.net",
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
        expect(new Headers(init?.headers).get("x-hayasend-source")).toBe(
          "cli",
        );
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
      [
        "templates",
        "render-version",
        "welcome",
        version,
        "--var",
        "NAME=Ada",
      ],
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
      runCli(
        ["templates", "restore-version", "welcome", "not-a-version"],
        { fetch: fetchMock, io: capture.io },
      ),
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
    await runCli(
      ["webhooks", "inspect-delivery", "wh/one", "whd/two"],
      { fetch: fetchMock, io: capture.io },
    );
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
        [
          "webhooks",
          "deliveries",
          "wh_123",
          "--after",
          "not-a-delivery",
        ],
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
      runCli(
        ["webhooks", "replay", "wh_123", "msg_123"],
        dependencies,
      ),
    ).rejects.toThrow("requires --yes");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
