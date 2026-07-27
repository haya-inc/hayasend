import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

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

describe("HayaSend domain CLI", () => {
  it("runs the lifecycle with explicit domain deletion", async () => {
    const capture = capturingIo();
    const id = "dom_1234567890abcdef1234567890abcdef";
    const requests: Array<{
      body: unknown;
      method: string;
      url: string;
    }> = [];
    const domain = {
      id,
      name: "mail.example.com",
      status: "verified",
      region: "ap-northeast-1",
      records: [
        {
          record: "DKIM",
          name: "token._domainkey.mail.example.com",
          type: "CNAME",
          value: "token.dkim.amazonses.com",
          status: "verified",
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const url = String(input);
      requests.push({ body, method, url });
      if (method === "DELETE") {
        return jsonResponse({ object: "domain", id, deleted: true });
      }
      if (url.endsWith("/verify")) {
        return jsonResponse(domain);
      }
      if (url.includes("?")) {
        return jsonResponse({
          object: "list",
          data: [domain],
          has_more: false,
        });
      }
      return jsonResponse(domain);
    });

    const dependencies = {
      env: {
        HAYASEND_API_KEY: "domain-operator-secret",
        HAYASEND_BASE_URL: "https://mail.example.net/api",
      },
      fetch: fetchMock,
      io: capture.io,
    };
    await runCli(
      ["domains", "create", "--name", "  Mail.Example.COM.  "],
      dependencies,
    );
    await runCli(
      ["domains", "list", "--limit", "20", "--after", id],
      dependencies,
    );
    await runCli(["domains", "get", id], dependencies);
    await runCli(["domains", "verify", id], dependencies);
    await runCli(["domains", "delete", id, "--yes"], dependencies);

    expect(requests).toEqual([
      {
        body: { name: "Mail.Example.COM." },
        method: "POST",
        url: "https://mail.example.net/api/domains",
      },
      {
        body: undefined,
        method: "GET",
        url: `https://mail.example.net/api/domains?limit=20&after=${id}`,
      },
      {
        body: undefined,
        method: "GET",
        url: `https://mail.example.net/api/domains/${id}`,
      },
      {
        body: undefined,
        method: "POST",
        url: `https://mail.example.net/api/domains/${id}/verify`,
      },
      {
        body: undefined,
        method: "DELETE",
        url: `https://mail.example.net/api/domains/${id}`,
      },
    ]);
    expect(capture.logs).toHaveLength(5);
    expect(JSON.parse(capture.logs[0] ?? "{}")).toMatchObject({
      id,
      records: [expect.objectContaining({ record: "DKIM" })],
    });
    expect(capture.logs.join("\n")).not.toContain("domain-operator-secret");
  });

  it("requires explicit acknowledgement before deleting an SES identity", async () => {
    const id = "dom_1234567890abcdef1234567890abcdef";
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      runCli(["domains", "delete", id], {
        fetch: fetchMock,
        io: capturingIo().io,
      }),
    ).rejects.toThrow("requires --yes");
    await expect(
      runCli(["domains", "delete", id, "--yes", "--yes"], {
        fetch: fetchMock,
        io: capturingIo().io,
      }),
    ).rejects.toThrow("may be provided only once");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid inputs before sending", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const dependencies = {
      fetch: fetchMock,
      io: capturingIo().io,
    };

    await expect(
      runCli(["domains", "create", "--name", "not-a-domain"], dependencies),
    ).rejects.toThrow("Domain input is invalid");
    await expect(
      runCli(
        ["domains", "create", "--name", "example.com", "--region", "x"],
        dependencies,
      ),
    ).rejects.toThrow("Unknown option: --region");
    await expect(
      runCli(["domains", "list", "--limit", "0"], dependencies),
    ).rejects.toThrow("--limit must be an integer between 1 and 100");
    await expect(
      runCli(["domains", "list", "--after", "not-a-domain-id"], dependencies),
    ).rejects.toThrow("Domain ID is invalid");
    await expect(
      runCli(["domains", "get", "not-a-domain-id"], dependencies),
    ).rejects.toThrow("Domain ID is invalid");
    await expect(
      runCli(
        [
          "domains",
          "verify",
          "dom_1234567890abcdef1234567890abcdef",
          "unexpected",
        ],
        dependencies,
      ),
    ).rejects.toThrow("Unexpected argument");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
