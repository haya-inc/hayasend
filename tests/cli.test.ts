import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEndpoint, runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

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
});
