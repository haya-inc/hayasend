import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryAttachmentStorage } from "../src/adapters/attachment-storage.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { AttachmentService } from "../src/services/attachment-service.js";

function checksum(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function fixture() {
  const store = new MemoryStore();
  const storage = new MemoryAttachmentStorage();
  return {
    service: new AttachmentService(store, storage),
    storage,
    store,
  };
}

describe("AttachmentService", () => {
  it("creates a short-lived upload and resolves verified content", async () => {
    const { service } = fixture();
    const now = new Date("2030-01-01T00:00:00.000Z");
    const content = Buffer.from("attachment contents");
    const created = await service.create(
      {
        filename: "report.txt",
        content_type: "text/plain",
        size_bytes: content.byteLength,
        checksum_sha256: checksum(content),
      },
      "http://localhost:8787",
      now,
    );

    expect(created).toMatchObject({
      id: expect.stringMatching(/^att_[a-f0-9]{32}$/),
      upload_method: "PUT",
      upload_headers: { "content-type": "text/plain" },
      expires_at: "2030-01-01T00:15:00.000Z",
      attachment_expires_at: "2030-01-02T00:00:00.000Z",
    });
    const uploadUrl = new URL(created.upload_url);
    const record = await service.authorizeProxyUpload(
      created.id,
      uploadUrl.searchParams.get("token") ?? "",
      content.byteLength,
      now,
    );
    await service.upload(record, content, "text/plain");

    const resolved = await service.resolve(
      [{ attachment_id: created.id }],
      100,
      now,
    );
    expect(resolved).toEqual([
      expect.objectContaining({
        attachment_id: created.id,
        filename: "report.txt",
        content_type: "text/plain",
        size_bytes: content.byteLength,
        checksum_sha256: checksum(content),
        object_key: `attachments/${created.id}/content`,
      }),
    ]);
    const read = await service.read(resolved?.[0] ?? { filename: "" });
    expect(Buffer.from(read)).toEqual(content);
  });

  it("rejects expired upload tokens and mismatched content", async () => {
    const { service } = fixture();
    const now = new Date("2030-01-01T00:00:00.000Z");
    const content = Buffer.from("expected");
    const created = await service.create(
      {
        filename: "report.txt",
        content_type: "text/plain",
        size_bytes: content.byteLength,
        checksum_sha256: checksum(content),
      },
      "http://localhost:8787",
      now,
    );
    const uploadUrl = new URL(created.upload_url);
    const token = uploadUrl.searchParams.get("token") ?? "";
    await expect(
      service.authorizeProxyUpload(
        created.id,
        token,
        content.byteLength,
        new Date("2030-01-01T00:15:00.000Z"),
      ),
    ).rejects.toThrow("invalid or expired");

    const record = await service.authorizeProxyUpload(
      created.id,
      token,
      content.byteLength,
      now,
    );
    await expect(
      service.upload(record, Buffer.from("tampered"), "text/plain"),
    ).rejects.toThrow("checksum does not match");
    await expect(
      service.upload(record, content, "application/octet-stream"),
    ).rejects.toThrow("content type");
  });

  it("keeps inline base64 compatibility and rejects ambiguous encoding", async () => {
    const { service } = fixture();
    const content = Buffer.from("inline");
    await expect(
      service.resolve(
        [
          {
            filename: "inline.txt",
            content: content.toString("base64"),
          },
        ],
        0,
      ),
    ).resolves.toEqual([
      {
        filename: "inline.txt",
        content: content.toString("base64"),
        size_bytes: content.byteLength,
      },
    ]);
    await expect(
      service.resolve(
        [{ filename: "inline.txt", content: "not base64" }],
        0,
      ),
    ).rejects.toThrow("canonical base64");
  });
});
