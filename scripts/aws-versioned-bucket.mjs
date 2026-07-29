import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DELETE_BATCH = 100;
const MAX_PURGE_PASSES = 1_000;

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function parseVersionedBucketArgs(argv) {
  if (argv[0] !== "purge") {
    throw new Error("Usage: aws-versioned-bucket.mjs purge [options]");
  }
  const options = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("Every purge option requires one value.");
    }
    if (options.has(name)) {
      throw new Error(`${name} may only be provided once.`);
    }
    options.set(name, value);
  }
  const account = requiredOption(options, "--account");
  const region = requiredOption(options, "--region");
  const bucket = requiredOption(options, "--bucket");
  const confirmedBucket = requiredOption(options, "--confirm-bucket");
  const allowed = new Set([
    "--account",
    "--region",
    "--bucket",
    "--confirm-bucket",
  ]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unsupported option: ${name}`);
    }
  }
  if (!/^\d{12}$/.test(account)) {
    throw new Error("--account must be a 12-digit AWS account ID.");
  }
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes("..")
  ) {
    throw new Error("--bucket must be an exact valid S3 bucket name.");
  }
  if (bucket !== confirmedBucket) {
    throw new Error("--confirm-bucket must exactly match --bucket.");
  }
  return { account, region, bucket };
}

export async function defaultAwsJsonRunner(args) {
  const { stdout } = await execFileAsync(
    "aws",
    [...args, "--output", "json", "--no-cli-pager"],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (!stdout.trim()) {
    return {};
  }
  return JSON.parse(stdout);
}

function versionEntries(page) {
  return [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(
    ({ Key, VersionId }) => {
      if (typeof Key !== "string" || typeof VersionId !== "string") {
        throw new Error("S3 returned an invalid object-version entry.");
      }
      return { Key, VersionId };
    },
  );
}

export async function purgeVersionedBucket(
  { account, region, bucket },
  runAwsJson = defaultAwsJsonRunner,
) {
  const identity = await runAwsJson(["sts", "get-caller-identity"]);
  if (identity.Account !== account) {
    throw new Error(
      `Authenticated AWS account ${String(identity.Account)} does not match ${account}.`,
    );
  }

  let deletedVersions = 0;
  for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
    const page = await runAwsJson([
      "s3api",
      "list-object-versions",
      "--bucket",
      bucket,
      "--region",
      region,
      "--max-keys",
      "1000",
    ]);
    const entries = versionEntries(page);
    if (entries.length === 0) {
      return { ok: true, bucket, deleted_versions: deletedVersions };
    }
    for (let offset = 0; offset < entries.length; offset += MAX_DELETE_BATCH) {
      const objects = entries.slice(offset, offset + MAX_DELETE_BATCH);
      const result = await runAwsJson([
        "s3api",
        "delete-objects",
        "--bucket",
        bucket,
        "--region",
        region,
        "--delete",
        JSON.stringify({ Objects: objects, Quiet: true }),
      ]);
      if (Array.isArray(result.Errors) && result.Errors.length > 0) {
        throw new Error(
          `S3 refused to delete ${result.Errors.length} object versions.`,
        );
      }
      deletedVersions += objects.length;
    }
  }
  throw new Error("S3 version cleanup exceeded the bounded pass limit.");
}

async function main() {
  const options = parseVersionedBucketArgs(process.argv.slice(2));
  const result = await purgeVersionedBucket(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Cleanup failed.");
    process.exitCode = 1;
  });
}
