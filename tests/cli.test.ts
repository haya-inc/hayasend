import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeEndpoint,
  runCli,
} from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hayasend-cli-"));
  temporaryDirectories.push(directory);
  return directory;
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
    expect(() =>
      normalizeEndpoint("http://mail.example.com"),
    ).toThrow("Plain HTTP");
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
    expect(compose).toContain(
      "image: ghcr.io/haya-inc/hayasend:0.1.0",
    );
    expect(compose).toContain('"127.0.0.1:8787:8787"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("- ALL");
    expect(compose).toContain("no-new-privileges:true");
    expect(
      await readFile(
        join(directory, ".env.hayasend.example"),
        "utf8",
      ),
    ).toContain("HAYASEND_API_KEY=re_hayasend_dev");
    expect(
      (await stat(join(directory, "compose.hayasend.yaml"))).mode &
        0o777,
    ).toBe(0o644);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      ok: true,
      directory,
      created: [
        "compose.hayasend.yaml",
        ".env.hayasend.example",
      ],
    });

    await expect(
      runCli(["init"], { cwd: directory, io: capture.io }),
    ).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(
      join(directory, "compose.hayasend.yaml"),
      "utf8",
    )).toBe(compose);
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
    const fetchMock = vi.fn<typeof fetch>(
      async (input, init) => {
        const url = String(input);
        requests.push({
          authorization:
            new Headers(init?.headers).get("authorization"),
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
      },
    );

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
        fetch: vi.fn<typeof fetch>(
          async () => jsonResponse({ ok: true, service: "other" }),
        ),
        io: capturingIo().io,
      }),
    ).rejects.toThrow("did not identify itself as HayaSend");
  });

  it("sends and retrieves an explicit end-to-end test message", async () => {
    const capture = capturingIo();
    let subject = "";
    const fetchMock = vi.fn<typeof fetch>(
      async (input, init) => {
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
      },
    );

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
});
