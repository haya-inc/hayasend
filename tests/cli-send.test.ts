import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hayasend-send-cli-"));
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
  return {
    logs,
    io: {
      log: (message: string) => logs.push(message),
      error: vi.fn(),
    },
  };
}

describe("production email send CLI", () => {
  it("maps the complete non-attachment send surface without logging content", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "message.txt"), "Plain body\n");
    await writeFile(join(cwd, "message.html"), "<p>HTML body</p>\n");
    const capture = capturingIo();
    const future = new Date(Date.now() + 86_400_000)
      .toISOString()
      .replace("Z", "+00:00");
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://localhost:8787/emails");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(
        "order-123",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        from: "Product <sender@example.com>",
        to: ["one@example.net", "two@example.net"],
        subject: "Private subject",
        text: "Plain body\n",
        html: "<p>HTML body</p>\n",
        cc: ["manager@example.com"],
        bcc: ["archive@example.com"],
        reply_to: ["support@example.com"],
        headers: {
          "X-Correlation-ID": "case-42",
          "X-Environment": "test",
        },
        tags: [
          { name: "category", value: "transactional" },
          { name: "region", value: "apac" },
        ],
        scheduled_at: new Date(future).toISOString(),
      });
      return jsonResponse({
        id: "email_1234567890abcdef1234567890abcdef",
        to: ["one@example.net"],
        subject: "Private subject",
        text: "Plain body",
      });
    });
    const readStdin = vi.fn();

    await runCli(
      [
        "emails",
        "send",
        "--from",
        "Product <sender@example.com>",
        "--to",
        "one@example.net",
        "two@example.net",
        "--cc",
        "manager@example.com",
        "--bcc",
        "archive@example.com",
        "--reply-to",
        "support@example.com",
        "--subject",
        "Private subject",
        "--text-file",
        "message.txt",
        "--html-file",
        "message.html",
        "--scheduled-at",
        future,
        "--header",
        "X-Correlation-ID=case-42",
        "X-Environment=test",
        "--tag",
        "category=transactional",
        "region=apac",
        "--idempotency-key",
        "order-123",
      ],
      {
        cwd,
        fetch: fetchMock,
        io: capture.io,
        readStdin,
      },
    );

    expect(readStdin).not.toHaveBeenCalled();
    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual({
      id: "email_1234567890abcdef1234567890abcdef",
    });
    expect(capture.logs.join("\n")).not.toContain("one@example.net");
    expect(capture.logs.join("\n")).not.toContain("Private subject");
    expect(capture.logs.join("\n")).not.toContain("Plain body");
    expect(capture.logs.join("\n")).not.toContain("order-123");
  });

  it("keeps the root alias and accepts one bounded stdin body", async () => {
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        from: "sender@example.com",
        to: ["recipient@example.net"],
        subject: "stdin",
        text: "body from stdin",
      });
      return jsonResponse({
        id: "email_abcdefabcdefabcdefabcdefabcdefab",
      });
    });
    const readStdin = vi.fn(async () =>
      new TextEncoder().encode("body from stdin"),
    );

    await runCli(
      [
        "send",
        "--from",
        "sender@example.com",
        "--to",
        "recipient@example.net",
        "--subject",
        "stdin",
        "--text-file",
        "-",
      ],
      { fetch: fetchMock, io: capture.io, readStdin },
    );

    expect(readStdin).toHaveBeenCalledWith(9 * 1024 * 1024);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toEqual({
      id: "email_abcdefabcdefabcdefabcdefabcdefab",
    });
  });

  it("uploads hashed attachments before creating the email", async () => {
    const cwd = await temporaryDirectory();
    const pdf = Buffer.from("%PDF synthetic");
    const binary = Buffer.from([0, 1, 2, 3, 4]);
    await writeFile(join(cwd, "invoice.pdf"), pdf);
    await writeFile(join(cwd, "archive.bin"), binary);
    const capture = capturingIo();
    const events: string[] = [];
    let attachmentIndex = 0;
    const identifiers = [
      "att_11111111111111111111111111111111",
      "att_22222222222222222222222222222222",
    ];
    const contents = [pdf, binary];
    const types = ["application/pdf", "application/octet-stream"];
    const names = ["invoice.pdf", "archive.bin"];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "http://localhost:8787/attachments") {
        const current = attachmentIndex;
        attachmentIndex += 1;
        expect(new Headers(init?.headers).get("idempotency-key")).toBeNull();
        const declaration = JSON.parse(String(init?.body)) as {
          checksum_sha256: string;
        };
        expect(declaration).toEqual({
          filename: names[current],
          content_type: types[current],
          size_bytes: contents[current]?.byteLength,
          checksum_sha256: createHash("sha256")
            .update(contents[current] ?? new Uint8Array())
            .digest("hex"),
        });
        events.push(`declare:${current}`);
        return jsonResponse({
          id: identifiers[current],
          ...declaration,
          upload_method: "PUT",
          upload_url: `http://127.0.0.1:8787/upload/${current}?token=safe`,
          upload_headers: {
            "content-type": types[current],
            ...(current === 0
              ? {
                  "x-amz-checksum-sha256": Buffer.from(
                    declaration.checksum_sha256,
                    "hex",
                  ).toString("base64"),
                }
              : {}),
          },
        });
      }
      if (url.startsWith("http://127.0.0.1:8787/upload/")) {
        const current = Number(new URL(url).pathname.split("/").at(-1));
        expect(init?.method).toBe("PUT");
        expect(init?.redirect).toBe("error");
        const headers = new Headers(init?.headers);
        expect(headers.get("content-type")).toBe(types[current]);
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("idempotency-key")).toBeNull();
        expect(headers.get("x-amz-checksum-sha256")).toBe(
          current === 0
            ? createHash("sha256")
                .update(contents[current] ?? new Uint8Array())
                .digest("base64")
            : null,
        );
        expect(Buffer.from(init?.body as Uint8Array)).toEqual(
          contents[current],
        );
        events.push(`upload:${current}`);
        return new Response(null, { status: 204 });
      }
      expect(url).toBe("http://localhost:8787/emails");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(
        "attachment-retry",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        from: "sender@example.com",
        to: ["recipient@example.net"],
        subject: "attachments",
        text: "See attached.",
        attachments: [
          { attachment_id: identifiers[0] },
          { attachment_id: identifiers[1] },
        ],
      });
      events.push("send");
      return jsonResponse({
        id: "email_33333333333333333333333333333333",
      });
    });

    await runCli(
      [
        "emails",
        "send",
        "--from",
        "sender@example.com",
        "--to",
        "recipient@example.net",
        "--subject",
        "attachments",
        "--text",
        "See attached.",
        "--attachment",
        "invoice.pdf",
        "archive.bin",
        "--idempotency-key",
        "attachment-retry",
      ],
      { cwd, fetch: fetchMock, io: capture.io },
    );

    expect(events).toEqual([
      "declare:0",
      "upload:0",
      "declare:1",
      "upload:1",
      "send",
    ]);
  });

  it("validates argument, file, and size failures before any request", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "invalid.txt"), new Uint8Array([0xff]));
    const largeOne = join(cwd, "large-one.bin");
    const largeTwo = join(cwd, "large-two.bin");
    const largeBody = join(cwd, "large-body.html");
    await writeFile(largeOne, "");
    await writeFile(largeTwo, "");
    await writeFile(largeBody, "");
    await truncate(largeOne, 13 * 1024 * 1024);
    await truncate(largeTwo, 13 * 1024 * 1024);
    await truncate(largeBody, 9 * 1024 * 1024 + 1);
    const directory = join(cwd, "directory");
    await mkdir(directory);
    const fetchMock = vi.fn<typeof fetch>();
    const base = [
      "emails",
      "send",
      "--from",
      "sender@example.com",
      "--to",
      "recipient@example.net",
      "--subject",
      "subject",
      "--text",
      "body",
    ];

    const invalidCommands: Array<[string[], string]> = [
      [
        [...base, "--text-file", "invalid.txt"],
        "cannot be combined",
      ],
      [
        [...base.slice(0, -2), "--text-file", "invalid.txt"],
        "valid UTF-8",
      ],
      [[...base, "--header", "Subject=override"], "managed by HayaSend"],
      [
        [
          ...base,
          "--header",
          "X-Case=one",
          "x-case=two",
        ],
        "more than once",
      ],
      [[...base, "--tag", "broken"], "NAME=VALUE"],
      [
        [...base, "--scheduled-at", "yesterday"],
        "scheduled_at",
      ],
      [
        [...base, "--idempotency-key", "x".repeat(257)],
        "256",
      ],
      [
        [
          ...base,
          "--attachment",
          ...Array.from({ length: 21 }, (_, index) => `file-${index}`),
        ],
        "At most 20",
      ],
      [
        [...base, "--attachment", largeOne, largeTwo],
        "25 MiB",
      ],
      [
        [
          ...base.slice(0, -2),
          "--html-file",
          largeBody,
        ],
        "9437184-byte limit",
      ],
      [
        [
          ...base,
          "--attachment",
          join(cwd, "missing.bin"),
        ],
        "ENOENT",
      ],
      [[...base, "--attachment", directory], "regular file"],
      [
        [
          ...base.slice(0, -2),
          "--text-file",
          "-",
          "--html-file",
          "-",
        ],
        "stdin may be used",
      ],
      [
        [
          ...base,
          "--template",
          "welcome",
        ],
        "cannot be combined",
      ],
    ];

    for (const [command, expected] of invalidCommands) {
      await expect(
        runCli(command, {
          cwd,
          fetch: fetchMock,
          io: capturingIo().io,
          readStdin: vi.fn(),
        }),
      ).rejects.toThrow(expected);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a symlinked body but reads the resolved regular file", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "actual.txt"), "resolved body");
    await symlink("actual.txt", join(cwd, "linked.txt"));
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        text: "resolved body",
      });
      return jsonResponse({
        id: "email_44444444444444444444444444444444",
      });
    });

    await runCli(
      [
        "emails",
        "send",
        "--from",
        "sender@example.com",
        "--to",
        "recipient@example.net",
        "--subject",
        "symlink",
        "--text-file",
        "linked.txt",
      ],
      { cwd, fetch: fetchMock, io: capturingIo().io },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses unsafe or inconsistent upload contracts before uploading bytes", async () => {
    const cwd = await temporaryDirectory();
    const content = Buffer.from("private attachment");
    await writeFile(join(cwd, "private.txt"), content);
    const checksum = createHash("sha256").update(content).digest("hex");
    const declaration = {
      id: "att_55555555555555555555555555555555",
      filename: "private.txt",
      content_type: "text/plain",
      size_bytes: content.byteLength,
      checksum_sha256: checksum,
      upload_method: "PUT",
      upload_headers: { "content-type": "text/plain" },
    };
    const unsafeFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ...declaration,
        upload_url: "http://169.254.169.254/latest/meta-data",
      }),
    );

    await expect(
      runCli(
        [
          "emails",
          "send",
          "--from",
          "sender@example.com",
          "--to",
          "recipient@example.net",
          "--subject",
          "unsafe",
          "--text",
          "body",
          "--attachment",
          "private.txt",
        ],
        {
          cwd,
          fetch: unsafeFetch,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow("unsafe attachment upload URL");
    expect(unsafeFetch).toHaveBeenCalledOnce();

    const outsideFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ...declaration,
        upload_url: "https://uploads.example.com/private.txt",
      }),
    );
    await expect(
      runCli(
        [
          "emails",
          "send",
          "--from",
          "sender@example.com",
          "--to",
          "recipient@example.net",
          "--subject",
          "outside",
          "--text",
          "body",
          "--attachment",
          "private.txt",
        ],
        {
          cwd,
          fetch: outsideFetch,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow("outside its API origin or AWS S3");
    expect(outsideFetch).toHaveBeenCalledOnce();

    const mismatchedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ...declaration,
        checksum_sha256: "0".repeat(64),
        upload_url: "https://bucket.s3.us-east-1.amazonaws.com/object",
      }),
    );
    await expect(
      runCli(
        [
          "emails",
          "send",
          "--from",
          "sender@example.com",
          "--to",
          "recipient@example.net",
          "--subject",
          "mismatch",
          "--text",
          "body",
          "--attachment",
          "private.txt",
        ],
        {
          cwd,
          fetch: mismatchedFetch,
          io: capturingIo().io,
        },
      ),
    ).rejects.toThrow("invalid attachment upload");
    expect(mismatchedFetch).toHaveBeenCalledOnce();
  });

  it("does not create an email when an attachment PUT fails", async () => {
    const cwd = await temporaryDirectory();
    const content = Buffer.from("private attachment");
    await writeFile(join(cwd, "private.txt"), content);
    const checksum = createHash("sha256").update(content).digest("hex");
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      requests.push(String(input));
      if (String(input) === "http://localhost:8787/attachments") {
        return jsonResponse({
          id: "att_66666666666666666666666666666666",
          filename: "private.txt",
          content_type: "text/plain",
          size_bytes: content.byteLength,
          checksum_sha256: checksum,
          upload_method: "PUT",
          upload_url: "https://bucket.s3.us-east-1.amazonaws.com/object",
          upload_headers: { "content-type": "text/plain" },
        });
      }
      return new Response("sensitive provider response", { status: 503 });
    });

    await expect(
      runCli(
        [
          "emails",
          "send",
          "--from",
          "sender@example.com",
          "--to",
          "recipient@example.net",
          "--subject",
          "failed upload",
          "--text",
          "body",
          "--attachment",
          "private.txt",
        ],
        { cwd, fetch: fetchMock, io: capturingIo().io },
      ),
    ).rejects.toThrow("Attachment upload failed with HTTP 503");
    expect(requests).toEqual([
      "http://localhost:8787/attachments",
      "https://bucket.s3.us-east-1.amazonaws.com/object",
    ]);
  });

  it("does not echo sensitive server responses from send operations", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, "private-contract.pdf"),
      "%PDF synthetic private attachment",
    );
    const capture = capturingIo();
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      jsonResponse(
        {
          name: "validation_error",
          message:
            String(input).endsWith("/attachments")
              ? "private-contract.pdf could not be declared"
              : "private-recipient@example.net private body",
          idempotency_key: "private-retry-key",
        },
        422,
      ),
    );

    let sendFailure: unknown;
    try {
      await runCli(
        [
          "emails",
          "send",
          "--from",
          "sender@example.com",
          "--to",
          "private-recipient@example.net",
          "--subject",
          "private subject",
          "--text",
          "private body",
          "--idempotency-key",
          "private-retry-key",
        ],
        { fetch: fetchMock, io: capture.io },
      );
    } catch (error) {
      sendFailure = error;
    }
    expect(sendFailure).toBeInstanceOf(Error);
    expect((sendFailure as Error).message).toBe(
      "Email creation failed with HTTP 422.",
    );
    expect((sendFailure as Error).message).not.toContain(
      "private-recipient@example.net",
    );
    expect((sendFailure as Error).message).not.toContain("private body");
    expect((sendFailure as Error).message).not.toContain("private-retry-key");

    let attachmentFailure: unknown;
    try {
      await runCli(
        [
          "emails",
          "send",
          "--from",
          "sender@example.com",
          "--to",
          "private-recipient@example.net",
          "--subject",
          "private subject",
          "--text",
          "private body",
          "--attachment",
          "private-contract.pdf",
        ],
        { cwd, fetch: fetchMock, io: capture.io },
      );
    } catch (error) {
      attachmentFailure = error;
    }
    expect(attachmentFailure).toBeInstanceOf(Error);
    expect((attachmentFailure as Error).message).toBe(
      "Attachment declaration failed with HTTP 422.",
    );
    expect((attachmentFailure as Error).message).not.toContain(
      "private-contract.pdf",
    );
    expect(capture.logs).toEqual([]);
  });
});
