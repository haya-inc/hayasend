import { describe, expect, it, vi } from "vitest";
import {
  parseVersionedBucketArgs,
  purgeVersionedBucket,
} from "../scripts/aws-versioned-bucket.mjs";

describe("AWS versioned bucket cleanup", () => {
  it("requires exact account and bucket confirmations", () => {
    expect(() =>
      parseVersionedBucketArgs([
        "purge",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--bucket",
        "hayasend-test-bucket",
        "--confirm-bucket",
        "another-bucket",
      ]),
    ).toThrow("--confirm-bucket must exactly match --bucket");
    expect(() =>
      parseVersionedBucketArgs([
        "purge",
        "--account",
        "not-an-account",
        "--region",
        "ap-northeast-1",
        "--bucket",
        "hayasend-test-bucket",
        "--confirm-bucket",
        "hayasend-test-bucket",
      ]),
    ).toThrow("--account must be a 12-digit AWS account ID");
    expect(() =>
      parseVersionedBucketArgs([
        "purge",
        "--account",
        "123456789012",
        "--region",
        "ap-northeast-1",
        "--bucket",
        "hayasend-test-bucket",
        "--confirm-bucket",
        "hayasend-test-bucket",
        "--prefix",
        "hayasend/run-1/",
        "--confirm-prefix",
        "hayasend/run-2/",
      ]),
    ).toThrow("--confirm-prefix must exactly match");
  });

  it("deletes all versions and delete markers in bounded batches", async () => {
    const calls: string[][] = [];
    const pages = [
      {
        Versions: [
          { Key: "attachments/a/content", VersionId: "v1" },
          { Key: "attachments/a/content", VersionId: "v2" },
        ],
        DeleteMarkers: [{ Key: "attachments/a/content", VersionId: "marker" }],
      },
      {},
    ];
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "sts") {
        return { Account: "123456789012" };
      }
      if (args[1] === "list-object-versions") {
        return pages.shift() ?? {};
      }
      if (args[1] === "delete-objects") {
        return {};
      }
      throw new Error(`Unexpected AWS call: ${args.join(" ")}`);
    });

    await expect(
      purgeVersionedBucket(
        {
          account: "123456789012",
          region: "ap-northeast-1",
          bucket: "hayasend-test-bucket",
        },
        runner,
      ),
    ).resolves.toEqual({
      ok: true,
      bucket: "hayasend-test-bucket",
      deleted_versions: 3,
    });
    const deletion = calls.find((args) => args[1] === "delete-objects");
    expect(JSON.parse(deletion?.at(-1) ?? "{}")).toEqual({
      Objects: [
        { Key: "attachments/a/content", VersionId: "v1" },
        { Key: "attachments/a/content", VersionId: "v2" },
        { Key: "attachments/a/content", VersionId: "marker" },
      ],
      Quiet: true,
    });
  });

  it("limits listing and deletion to an exactly confirmed prefix", async () => {
    const calls: string[][] = [];
    const pages = [
      {
        Versions: [{ Key: "hayasend/run-1/artifact", VersionId: "v1" }],
      },
      {},
    ];
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "sts") {
        return { Account: "123456789012" };
      }
      if (args[1] === "list-object-versions") {
        return pages.shift() ?? {};
      }
      if (args[1] === "delete-objects") {
        return {};
      }
      throw new Error(`Unexpected AWS call: ${args.join(" ")}`);
    });

    await purgeVersionedBucket(
      {
        account: "123456789012",
        region: "ap-northeast-1",
        bucket: "hayasend-test-bucket",
        prefix: "hayasend/run-1/",
      },
      runner,
    );

    const listings = calls.filter((args) => args[1] === "list-object-versions");
    expect(listings).toHaveLength(2);
    expect(listings[0]).toContain("--prefix");
    expect(listings[0]).toContain("hayasend/run-1/");
    expect(
      JSON.parse(
        calls.find((args) => args[1] === "delete-objects")?.at(-1) ?? "{}",
      ),
    ).toEqual({
      Objects: [{ Key: "hayasend/run-1/artifact", VersionId: "v1" }],
      Quiet: true,
    });
  });

  it("refuses a mismatched live AWS account before listing objects", async () => {
    const runner = vi.fn(async () => ({ Account: "999999999999" }));
    await expect(
      purgeVersionedBucket(
        {
          account: "123456789012",
          region: "ap-northeast-1",
          bucket: "hayasend-test-bucket",
        },
        runner,
      ),
    ).rejects.toThrow("does not match");
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
