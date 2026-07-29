import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const environmentFile = resolve(".hayasend-proof", "vercel-production.env");

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
  /[\u0000-\u001f\u007f]/.test(token) ||
  !token.includes("vercel_blob_rw_")
) {
  throw new Error("The pulled production Blob token is invalid.");
}

writeSync(3, `${token}\n`, null, "utf8");
await unlink(environmentFile);

process.stdout.write(
  `${JSON.stringify({
    object: "vercel_blob_token_extraction",
    source_deleted: true,
    credential_channel: "file_descriptor_3",
    token_sha256: createHash("sha256").update(token).digest("hex"),
  })}\n`,
);
