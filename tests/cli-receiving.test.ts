import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

const RECEIVED_ID = `recv_${"1".repeat(32)}`;
const ATTACHMENT_ID = `att_${"2".repeat(32)}`;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hayasend-receiving-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function capturingIo() {
  const logs: string[] = [];
  return {
    logs,
    io: {
      log: (message: string) => logs.push(message),
      error: vi.fn(),
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function futureExpiry() {
  return new Date(Date.now() + 15 * 60_000).toISOString();
}

function attachmentTarget(overrides: Record<string, unknown> = {}) {
  return {
    object: "attachment",
    id: ATTACHMENT_ID,
    filename: "private-contract.pdf",
    size: 4,
    content_type: "application/pdf",
    content_disposition: "attachment",
    content_id: null,
    download_url:
      "https://private-bucket.s3.us-east-1.amazonaws.com/inbound/private-contract.pdf?X-Amz-Signature=secret-signature",
    expires_at: futureExpiry(),
    ...overrides,
  };
}

function receivedRecord(overrides: Record<string, unknown> = {}) {
  return {
    object: "email",
    id: RECEIVED_ID,
    from: "Founder <founder@example.com>",
    to: ["inbound@example.net"],
    received_for: ["private-alias@example.net"],
    bcc: ["hidden@example.net"],
    cc: ["legal@example.net"],
    reply_to: ["reply@example.com"],
    subject: "Private acquisition",
    message_id: "<confidential-message@example.com>",
    attachments: [
      {
        id: ATTACHMENT_ID,
        filename: "private-contract.pdf",
        size: 4,
        content_type: "application/pdf",
        content_disposition: "attachment",
        content_id: null,
      },
    ],
    created_at: "2030-01-01T00:00:00.000Z",
    content_truncated: true,
    html: "<p>Confidential terms</p>",
    html_format: "cid",
    text: "Confidential terms",
    headers: { "x-private-case": "merger-42" },
    raw: {
      download_url:
        "https://private-bucket.s3.us-east-1.amazonaws.com/inbound/message.eml?X-Amz-Signature=raw-secret",
      expires_at: futureExpiry(),
    },
    ...overrides,
  };
}

describe("received-email CLI", () => {
  it("lists and retrieves privacy-safe summaries by default", async () => {
    const capture = capturingIo();
    const requests: string[] = [];
    const record = receivedRecord();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      return jsonResponse(
        url.includes("/emails/receiving?")
          ? {
              object: "list",
              data: [record],
              has_more: true,
              next_cursor: "recv_next",
              internal_note: "must not be copied",
            }
          : record,
      );
    });

    await runCli(
      [
        "emails",
        "receiving",
        "list",
        "--limit",
        "20",
        "--after",
        "recv/previous",
      ],
      { fetch: fetchMock, io: capture.io },
    );
    await runCli(["emails", "receiving", "get", RECEIVED_ID], {
      fetch: fetchMock,
      io: capture.io,
    });

    const summary = {
      object: "received_email_summary",
      id: RECEIVED_ID,
      created_at: "2030-01-01T00:00:00.000Z",
      recipient_count: 3,
      envelope_recipient_count: 1,
      attachment_count: 1,
      content_truncated: true,
    };
    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual({
      object: "list",
      data: [summary],
      has_more: true,
      next_cursor: "recv_next",
    });
    expect(JSON.parse(capture.logs[1] ?? "{}")).toEqual(summary);
    const output = capture.logs.join("\n");
    for (const secret of [
      "founder@example.com",
      "private-alias@example.net",
      "Private acquisition",
      "Confidential terms",
      "private-contract.pdf",
      "confidential-message",
      "merger-42",
      "secret-signature",
      "must not be copied",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(requests).toEqual([
      "http://localhost:8787/emails/receiving?limit=20&after=recv%2Fprevious",
      `http://localhost:8787/emails/receiving/${RECEIVED_ID}?html_format=cid`,
    ]);
  });

  it("reveals only validated fields after explicit content opt-in", async () => {
    const capture = capturingIo();
    const record = receivedRecord({ internal_note: "server-only" });
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(record));

    await runCli(
      [
        "emails",
        "receiving",
        "get",
        RECEIVED_ID,
        "--include-content",
        "--html-format",
        "cid",
      ],
      { fetch: fetchMock, io: capture.io },
    );

    const output = JSON.parse(capture.logs[0] ?? "{}");
    expect(output).toMatchObject({
      id: RECEIVED_ID,
      from: "Founder <founder@example.com>",
      subject: "Private acquisition",
      text: "Confidential terms",
      html_format: "cid",
      raw: { download_url: expect.stringContaining("X-Amz-Signature") },
    });
    expect(output).not.toHaveProperty("internal_note");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://localhost:8787/emails/receiving/${RECEIVED_ID}?html_format=cid`,
    );
    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "get",
          RECEIVED_ID,
          "--html-format",
          "cid",
        ],
        { fetch: fetchMock, io: capture.io },
      ),
    ).rejects.toThrow("--html-format requires --include-content");
  });

  it("lists selectable attachment metadata without signed URLs", async () => {
    const capture = capturingIo();
    await runCli(
      ["emails", "receiving", "attachments", RECEIVED_ID],
      {
        fetch: vi.fn<typeof fetch>(async () =>
          jsonResponse({
            object: "list",
            data: [attachmentTarget()],
            has_more: false,
          }),
        ),
        io: capture.io,
      },
    );

    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual({
      object: "list",
      data: [
        {
          object: "attachment_summary",
          id: ATTACHMENT_ID,
          filename: "private-contract.pdf",
          size: 4,
          content_type: "application/pdf",
          content_disposition: "attachment",
          has_content_id: false,
        },
      ],
      has_more: false,
    });
    expect(capture.logs[0]).not.toContain("download_url");
    expect(capture.logs[0]).not.toContain("secret-signature");
  });

  it("downloads an attachment without forwarding credentials or its signed URL", async () => {
    const directory = await temporaryDirectory();
    const capture = capturingIo();
    const content = new Uint8Array([1, 2, 3, 4]);
    const requests: Array<{
      url: string;
      authorization: string | null;
      redirect: RequestRedirect | undefined;
    }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      if (url.startsWith("http://localhost:8787/")) {
        return jsonResponse(attachmentTarget());
      }
      return new Response(content, {
        headers: {
          "content-length": String(content.byteLength),
          "content-type": "application/pdf",
        },
      });
    });

    await runCli(
      [
        "emails",
        "receiving",
        "attachment",
        RECEIVED_ID,
        ATTACHMENT_ID,
        "--output",
        "saved.pdf",
      ],
      {
        cwd: directory,
        env: { HAYASEND_API_KEY: "re_private_key" },
        fetch: fetchMock,
        io: capture.io,
      },
    );

    const outputPath = join(directory, "saved.pdf");
    expect(await readFile(outputPath)).toEqual(Buffer.from(content));
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe("Bearer re_private_key");
    expect(requests[1]?.authorization).toBeNull();
    expect(requests[1]?.redirect).toBe("error");
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      object: "download",
      kind: "attachment",
      path: await realpath(outputPath),
      size: 4,
      sha256:
        "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    });
    expect(capture.logs[0]).not.toContain("X-Amz-Signature");
  });

  it("downloads raw MIME privately and verifies the canceled URL is never logged", async () => {
    const directory = await temporaryDirectory();
    const capture = capturingIo();
    const raw = Buffer.from("From: sender@example.com\r\n\r\nPrivate body\r\n");
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).startsWith("http://localhost:8787/")) {
        return jsonResponse(receivedRecord());
      }
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(raw, {
        headers: { "content-length": String(raw.byteLength) },
      });
    });

    await runCli(
      [
        "emails",
        "receiving",
        "raw",
        RECEIVED_ID,
        "--output",
        "message.eml",
      ],
      { cwd: directory, fetch: fetchMock, io: capture.io },
    );

    expect(await readFile(join(directory, "message.eml"))).toEqual(raw);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      object: "download",
      kind: "raw_email",
      size: raw.byteLength,
    });
    expect(capture.logs[0]).not.toContain("raw-secret");
    expect(capture.logs[0]).not.toContain("Private body");
  });

  it("rejects unsafe, expired, redirected, and oversized download targets", async () => {
    const directory = await temporaryDirectory();
    const capture = capturingIo();
    const command = [
      "emails",
      "receiving",
      "attachment",
      RECEIVED_ID,
      ATTACHMENT_ID,
      "--output",
      "blocked.bin",
    ];
    const unsafeFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        attachmentTarget({
          download_url:
            "https://metadata.internal.example/private?token=secret",
        }),
      ),
    );
    await expect(
      runCli(command, {
        cwd: directory,
        fetch: unsafeFetch,
        io: capture.io,
      }),
    ).rejects.toThrow("outside its API origin or AWS S3");
    expect(unsafeFetch).toHaveBeenCalledTimes(1);

    await expect(
      runCli(command, {
        cwd: directory,
        fetch: vi.fn<typeof fetch>(async () =>
          jsonResponse(
            attachmentTarget({
              expires_at: new Date(Date.now() - 1_000).toISOString(),
            }),
          ),
        ),
        io: capture.io,
      }),
    ).rejects.toThrow("expired download target");

    const redirectFetch = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("http://localhost:8787/")) {
        return jsonResponse(attachmentTarget());
      }
      throw new TypeError(
        "redirect to https://private-bucket.s3.amazonaws.com/?secret",
      );
    });
    await expect(
      runCli(command, {
        cwd: directory,
        fetch: redirectFetch,
        io: capture.io,
      }),
    ).rejects.toThrow("Download request failed");

    const oversizedFetch = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("http://localhost:8787/")) {
        return jsonResponse(
          attachmentTarget({ size: MAX_DOWNLOAD_BYTES }),
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20 * 1024 * 1024));
          controller.enqueue(new Uint8Array(6 * 1024 * 1024));
          controller.close();
        },
      });
      return new Response(stream);
    });
    await expect(
      runCli(command, {
        cwd: directory,
        fetch: oversizedFetch,
        io: capture.io,
      }),
    ).rejects.toThrow("exceeds the 25 MiB limit");
    expect(await readdir(directory)).toEqual([]);
  });

  it("preflights overwrite protection and replaces only with --force", async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "existing.bin");
    await writeFile(outputPath, "keep");
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("http://localhost:8787/")) {
        return jsonResponse(attachmentTarget());
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-length": "4" },
      });
    });
    const command = [
      "emails",
      "receiving",
      "attachment",
      RECEIVED_ID,
      ATTACHMENT_ID,
      "--output",
      "existing.bin",
    ];

    await expect(
      runCli(command, {
        cwd: directory,
        fetch: fetchMock,
        io: capture.io,
      }),
    ).rejects.toThrow("Refusing to overwrite");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(outputPath, "utf8")).toBe("keep");

    await runCli([...command, "--force"], {
      cwd: directory,
      fetch: fetchMock,
      io: capture.io,
    });
    expect(await readFile(outputPath)).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).sort()).toEqual(["existing.bin"]);
  });

  it("leaves no output or temporary file after size mismatch", async () => {
    const directory = await temporaryDirectory();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("http://localhost:8787/")) {
        return jsonResponse(attachmentTarget());
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });

    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "attachment",
          RECEIVED_ID,
          ATTACHMENT_ID,
          "--output",
          "mismatch.bin",
        ],
        {
          cwd: directory,
          fetch: fetchMock,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow("size does not match attachment metadata");
    expect(await readdir(directory)).toEqual([]);
  });

  it("sanitizes stream failures and refuses empty raw MIME", async () => {
    const directory = await temporaryDirectory();
    const attachmentFetch = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("http://localhost:8787/")) {
        return jsonResponse(attachmentTarget());
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(
              new Error(
                "Download https://private-bucket.s3.amazonaws.com/?secret",
              ),
            );
          },
        }),
      );
    });
    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "attachment",
          RECEIVED_ID,
          ATTACHMENT_ID,
          "--output",
          "stream-error.bin",
        ],
        {
          cwd: directory,
          fetch: attachmentFetch,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow(/^Download request failed\.$/);

    const rawFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith("http://localhost:8787/")
        ? jsonResponse(receivedRecord())
        : new Response(new Uint8Array()),
    );
    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "raw",
          RECEIVED_ID,
          "--output",
          "empty.eml",
        ],
        {
          cwd: directory,
          fetch: rawFetch,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow("Download returned no content");
    expect(await readdir(directory)).toEqual([]);
  });

  it("fails closed on malformed received-email and attachment contracts", async () => {
    const capture = capturingIo();
    await expect(
      runCli(["emails", "receiving", "list"], {
        fetch: vi.fn<typeof fetch>(async () =>
          jsonResponse({ object: "list", data: [{}], has_more: false }),
        ),
        io: capture.io,
      }),
    ).rejects.toThrow("invalid received email record");
    await expect(
      runCli(
        ["emails", "receiving", "attachments", RECEIVED_ID],
        {
          fetch: vi.fn<typeof fetch>(async () =>
            jsonResponse({
              object: "list",
              data: [
                attachmentTarget({
                  download_url:
                    "https://private-bucket.s3.amazonaws.com/?X-Amz-Signature=secret",
                  size: -1,
                }),
              ],
              has_more: false,
            }),
          ),
          io: capture.io,
        },
      ),
    ).rejects.toThrow("invalid received attachment");
    expect(capture.logs).toEqual([]);
  });
});
