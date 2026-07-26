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

function listenRecord(index: number, overrides: Record<string, unknown> = {}) {
  return receivedRecord({
    id: `recv_${index.toString(16).padStart(32, "0")}`,
    from: `Private Sender ${index} <private-${index}@example.com>`,
    to: [`private-recipient-${index}@example.net`],
    received_for: [`private-alias-${index}@example.net`],
    bcc: [],
    cc: [],
    reply_to: [],
    subject: `Private subject ${index}`,
    message_id: `<private-${index}@example.com>`,
    attachments: [],
    content_truncated: false,
    html: `Private HTML ${index}`,
    text: `Private text ${index}`,
    headers: { "x-private-sequence": String(index) },
    ...overrides,
  });
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

  it("listens for new email in chronological, secret-free NDJSON", async () => {
    const capture = capturingIo();
    const seed = listenRecord(1);
    const older = listenRecord(2, {
      created_at: "2030-01-01T00:00:01.000Z",
    });
    const newer = listenRecord(3, {
      created_at: "2030-01-01T00:00:02.000Z",
    });
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      return requests.length === 1
        ? jsonResponse({
            object: "list",
            data: [seed],
            has_more: true,
            next_cursor: "ignored-seed-cursor",
          })
        : jsonResponse({
            object: "list",
            data: [newer, older, seed],
            has_more: false,
          });
    });
    const sleep = vi.fn(async () => undefined);

    await runCli(
      [
        "emails",
        "receiving",
        "listen",
        "--interval",
        "2",
        "--max-polls",
        "1",
      ],
      { fetch: fetchMock, io: capture.io, sleep },
    );

    expect(sleep).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(requests).toEqual([
      "http://localhost:8787/emails/receiving?limit=1",
      "http://localhost:8787/emails/receiving?limit=100",
    ]);
    expect(capture.logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        object: "received_email_summary",
        id: older.id,
      }),
      expect.objectContaining({
        object: "received_email_summary",
        id: newer.id,
      }),
    ]);
    expect(capture.io.error).not.toHaveBeenCalled();
    const output = capture.logs.join("\n");
    for (const privateValue of [
      "Private Sender",
      "private-recipient",
      "private-alias",
      "Private subject",
      "Private HTML",
      "Private text",
      "x-private-sequence",
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("continues a bounded multipage backlog on the next poll", async () => {
    const capture = capturingIo();
    const seed = listenRecord(1);
    const unseen = Array.from({ length: 501 }, (_, index) =>
      listenRecord(index + 2),
    );
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (requests.length === 1) {
        return jsonResponse({
          object: "list",
          data: [seed],
          has_more: false,
        });
      }
      const page = requests.length - 2;
      if (page < 5) {
        return jsonResponse({
          object: "list",
          data: unseen.slice(page * 100, page * 100 + 100),
          has_more: true,
          next_cursor: `cursor-${page + 1}`,
        });
      }
      return jsonResponse({
        object: "list",
        data: [unseen[500], seed],
        has_more: false,
      });
    });
    const sleep = vi.fn(async () => undefined);

    await runCli(
      [
        "emails",
        "receiving",
        "listen",
        "--interval",
        "2",
        "--max-polls",
        "2",
      ],
      { fetch: fetchMock, io: capture.io, sleep },
    );

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(7);
    expect(requests.at(-1)).toBe(
      "http://localhost:8787/emails/receiving?limit=100&after=cursor-5",
    );
    expect(capture.logs).toHaveLength(501);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      id: unseen[500]?.id,
    });
    expect(JSON.parse(capture.logs.at(-1) ?? "{}")).toMatchObject({
      id: unseen[0]?.id,
    });
    expect(
      new Set(
        capture.logs.map(
          (line) => (JSON.parse(line) as { id: string }).id,
        ),
      ).size,
    ).toBe(501);
    expect(capture.io.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        object: "listen_warning",
        code: "page_cap_reached",
        pending_count: 500,
      }),
    );
  });

  it("preserves partial pages and retries the same cursor after failure", async () => {
    const capture = capturingIo();
    const seed = listenRecord(1);
    const newer = listenRecord(3);
    const older = listenRecord(2);
    let requestNumber = 0;
    const urls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      requestNumber += 1;
      urls.push(String(input));
      if (requestNumber === 1) {
        return jsonResponse({
          object: "list",
          data: [seed],
          has_more: false,
        });
      }
      if (requestNumber === 2) {
        return jsonResponse({
          object: "list",
          data: [newer],
          has_more: true,
          next_cursor: "resume-here",
        });
      }
      if (requestNumber === 3) {
        throw new Error(
          "private-recipient@example.net private subject signed-url",
        );
      }
      return jsonResponse({
        object: "list",
        data: [older, seed],
        has_more: false,
      });
    });

    await runCli(
      [
        "emails",
        "receiving",
        "listen",
        "--max-polls",
        "2",
      ],
      {
        fetch: fetchMock,
        io: capture.io,
        sleep: async () => undefined,
      },
    );

    expect(urls.slice(-2)).toEqual([
      "http://localhost:8787/emails/receiving?limit=100&after=resume-here",
      "http://localhost:8787/emails/receiving?limit=100&after=resume-here",
    ]);
    expect(capture.logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: older.id }),
      expect.objectContaining({ id: newer.id }),
    ]);
    expect(capture.io.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        object: "listen_warning",
        code: "poll_failed",
        consecutive_failures: 1,
      }),
    );
    expect(JSON.stringify(capture.io.error.mock.calls)).not.toContain(
      "private-recipient",
    );
  });

  it("fails after five sanitized polling failures", async () => {
    const capture = capturingIo();
    let requestNumber = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return jsonResponse({
          object: "list",
          data: [listenRecord(1)],
          has_more: false,
        });
      }
      throw new Error("private sender, subject, and signed URL");
    });

    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "listen",
          "--max-polls",
          "5",
        ],
        {
          fetch: fetchMock,
          io: capture.io,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow(
      "Receiving listen stopped after 5 consecutive API failures.",
    );
    expect(capture.logs).toEqual([]);
    expect(capture.io.error).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(capture.io.error.mock.calls)).not.toContain(
      "private sender",
    );
  });

  it("fails closed on invalid listen options and cursors", async () => {
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "listen",
          "--interval",
          "1",
          "--max-polls",
          "1",
        ],
        { fetch: fetchMock, io: capture.io },
      ),
    ).rejects.toThrow("--interval must be an integer from 2 to 3600");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "listen",
          "--max-polls",
          "1",
        ],
        {
          fetch: vi.fn<typeof fetch>(async () => {
            throw new Error("private sender, subject, and signed URL");
          }),
          io: capture.io,
        },
      ),
    ).rejects.toThrow("Receiving listen could not connect to HayaSend.");

    let requestNumber = 0;
    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "listen",
          "--max-polls",
          "1",
        ],
        {
          fetch: vi.fn<typeof fetch>(async () => {
            requestNumber += 1;
            return requestNumber === 1
              ? jsonResponse({
                  object: "list",
                  data: [listenRecord(1)],
                  has_more: false,
                })
              : jsonResponse({
                  object: "list",
                  data: [listenRecord(2)],
                  has_more: true,
                });
          }),
          io: capture.io,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow("invalid receiving pagination cursor");
    expect(capture.logs).toEqual([]);
    expect(capture.io.error).not.toHaveBeenCalled();
  });

  it("fails loudly before buffering more than 5000 unseen messages", async () => {
    const capture = capturingIo();
    let requestNumber = 0;
    await expect(
      runCli(
        [
          "emails",
          "receiving",
          "listen",
          "--max-polls",
          "11",
        ],
        {
          fetch: vi.fn<typeof fetch>(async () => {
            requestNumber += 1;
            if (requestNumber === 1) {
              return jsonResponse({
                object: "list",
                data: [listenRecord(1)],
                has_more: false,
              });
            }
            const page = requestNumber - 2;
            const pageSize = page === 50 ? 1 : 100;
            return jsonResponse({
              object: "list",
              data: Array.from({ length: pageSize }, (_, offset) =>
                listenRecord(page * 100 + offset + 2),
              ),
              has_more: true,
              next_cursor: `cursor-${page + 1}`,
            });
          }),
          io: capture.io,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow(
      "Receiving listen backlog exceeds 5000 messages",
    );
    expect(requestNumber).toBe(52);
    expect(capture.logs).toEqual([]);
    expect(capture.io.error).toHaveBeenCalledTimes(10);
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
