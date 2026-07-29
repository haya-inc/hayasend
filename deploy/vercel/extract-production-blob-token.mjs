import { createHash } from "node:crypto";
import {
  chmod,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";

const [environmentFile, tokenFile] = process.argv.slice(2);
if (!environmentFile || !tokenFile) {
  throw new Error(
    "Usage: node extract-production-blob-token.mjs <vercel-env-file> <token-file>",
  );
}

const source = await readFile(environmentFile, "utf8");
const lines = source.split(/\r?\n/);
const matches = lines.filter((line) =>
  line.startsWith("BLOB_READ_WRITE_TOKEN="),
);
if (matches.length !== 1) {
  throw new Error(
    "Expected exactly one BLOB_READ_WRITE_TOKEN in the pulled production environment.",
  );
}

const raw = matches[0].slice("BLOB_READ_WRITE_TOKEN=".length);
let token;
if (raw.startsWith('"') && raw.endsWith('"')) {
  token = JSON.parse(raw);
} else if (raw.startsWith("'") && raw.endsWith("'")) {
  token = raw.slice(1, -1);
} else {
  token = raw;
}
if (
  typeof token !== "string" ||
  token.length < 32 ||
  token.length > 4_096 ||
  !token.includes("vercel_blob_rw_")
) {
  throw new Error("The pulled production Blob token is invalid.");
}

await writeFile(tokenFile, `${token}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
await chmod(tokenFile, 0o600);
await unlink(environmentFile);

process.stdout.write(
  `${JSON.stringify({
    object: "vercel_blob_token_extraction",
    source_deleted: true,
    token_file_mode: "0600",
    token_sha256: createHash("sha256").update(token).digest("hex"),
  })}\n`,
);
