import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { del, get, list } from "@vercel/blob";
import pg from "pg";

const { Pool } = pg;
const EMAIL_ID_PATTERN = /^email_[a-f0-9]{32}$/;
const ATTACHMENT_ID_PATTERN = /^att_[a-f0-9]{32}$/;
const CONTENT = Buffer.from(
  "HayaSend Vercel private Blob hosted proof.\n",
  "utf8",
);
const CHECKSUM = createHash("sha256").update(CONTENT).digest("hex");

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function origin() {
  const value = new URL(required("HAYASEND_HOSTED_PROOF_API_URL"));
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.search ||
    value.hash ||
    value.pathname !== "/"
  ) {
    throw new Error(
      "HAYASEND_HOSTED_PROOF_API_URL must be a credential-free HTTPS origin.",
    );
  }
  return value;
}

async function api(apiOrigin, apiKey, path, init = {}) {
  const response = await fetch(new URL(path, apiOrigin), {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`HayaSend hosted attachment API returned ${response.status}.`);
  }
  return response.json();
}

function assertUpload(value, apiOrigin) {
  if (
    !value ||
    !ATTACHMENT_ID_PATTERN.test(value.id ?? "") ||
    value.filename !== "proof.txt" ||
    value.content_type !== "text/plain" ||
    value.size_bytes !== CONTENT.byteLength ||
    value.checksum_sha256 !== CHECKSUM ||
    value.upload_method !== "PUT" ||
    !value.upload_headers ||
    value.upload_headers["content-type"] !== "text/plain"
  ) {
    throw new Error("HayaSend returned an invalid Blob upload contract.");
  }
  const upload = new URL(value.upload_url);
  if (
    upload.protocol !== "https:" ||
    upload.origin === apiOrigin.origin ||
    !upload.hostname.endsWith(".blob.vercel-storage.com") ||
    upload.username ||
    upload.password
  ) {
    throw new Error("HayaSend returned an invalid private Blob upload URL.");
  }
  return upload;
}

async function streamBytes(stream, expectedSize) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > expectedSize) {
      throw new Error("Private Blob content exceeded its declared size.");
    }
    chunks.push(value);
  }
  const content = Buffer.concat(chunks);
  if (content.byteLength !== expectedSize) {
    throw new Error("Private Blob content did not match its declared size.");
  }
  return content;
}

async function resolveEmailId(pool, idempotencyKey) {
  const keyHash = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex");
  const result = await pool.query(
    "SELECT email_id FROM idempotency_claims WHERE key_hash = $1",
    [keyHash],
  );
  if (result.rows.length > 1) {
    throw new Error("The hosted Blob proof idempotency identity is ambiguous.");
  }
  return result.rows[0]?.email_id;
}

async function resolveAttachmentId(pool) {
  const result = await pool.query(
    `SELECT id, entity
     FROM app_entities
     WHERE kind = 'attachment_upload'
     LIMIT 2`,
  );
  if (result.rows.length === 0) {
    return undefined;
  }
  if (
    result.rows.length !== 1 ||
    result.rows[0]?.entity?.filename !== "proof.txt" ||
    result.rows[0]?.entity?.checksum_sha256 !== CHECKSUM ||
    !ATTACHMENT_ID_PATTERN.test(result.rows[0]?.id ?? "")
  ) {
    throw new Error(
      "The hosted Blob proof attachment identity is ambiguous.",
    );
  }
  return result.rows[0].id;
}

async function cleanupDatabase(pool, emailId, attachmentId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let outboxId;
    if (emailId) {
      const outbox = await client.query(
        "SELECT id FROM outbox_items WHERE message_id = $1 LIMIT 2",
        [emailId],
      );
      if (outbox.rows.length > 1) {
        throw new Error("The hosted Blob proof outbox identity is ambiguous.");
      }
      outboxId = outbox.rows[0]?.id;
      await client.query(
        `DELETE FROM jobs
         WHERE envelope->'job'->>'email_id' = $1
            OR ($2::text IS NOT NULL
              AND envelope->'job'->>'outbox_id' = $2)`,
        [emailId, outboxId ?? null],
      );
      await client.query("DELETE FROM emails WHERE id = $1", [emailId]);
    }
    if (attachmentId) {
      await client.query(
        "DELETE FROM app_entities WHERE kind = 'attachment_upload' AND id = $1",
        [attachmentId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const remaining = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM emails WHERE id = $1) AS emails,
       (
         SELECT count(*)::int
         FROM app_entities
         WHERE kind = 'attachment_upload' AND id = $2
       ) AS attachments`,
    [emailId ?? null, attachmentId ?? null],
  );
  if (
    remaining.rows[0]?.emails !== 0 ||
    remaining.rows[0]?.attachments !== 0
  ) {
    throw new Error("Hosted Blob proof database cleanup is incomplete.");
  }
}

async function emptyProofStore(token) {
  const page = await list({ limit: 2, token });
  if (page.hasMore || page.blobs.length > 1) {
    throw new Error(
      "The dedicated Blob store contains objects outside the hosted proof.",
    );
  }
  if (page.blobs.length === 1) {
    await del(page.blobs[0].url, { token });
  }
  const after = await list({ limit: 1, token });
  if (after.hasMore || after.blobs.length !== 0) {
    throw new Error("Hosted Blob proof object cleanup is incomplete.");
  }
}

async function main() {
  const apiOrigin = origin();
  const apiKey = required("HAYASEND_API_KEY");
  const databaseUrl = required("HAYASEND_DATABASE_URL");
  const blobToken = required("BLOB_READ_WRITE_TOKEN");
  const evidenceFile = required("HAYASEND_VERCEL_BLOB_PROOF_FILE");
  if (
    !apiKey.startsWith("re_") ||
    apiKey.length < 16 ||
    blobToken.length < 32 ||
    !blobToken.includes("vercel_blob_rw_") ||
    !/^postgres(?:ql)?:\/\//.test(databaseUrl)
  ) {
    throw new Error("Hosted Blob proof credentials are invalid.");
  }
  const runComponent = `${required("GITHUB_RUN_ID")}-${required("GITHUB_RUN_ATTEMPT")}`;
  if (!/^[0-9]{1,20}-[0-9]{1,4}$/.test(runComponent)) {
    throw new Error("Hosted Blob proof run identity is invalid.");
  }
  const idempotencyKey = `hayasend-vercel-blob-${runComponent}`;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: "hayasend-vercel-blob-proof",
  });
  let attachmentId;
  let emailId;
  let proofComplete = false;
  let failure;

  try {
    const before = await list({ limit: 1, token: blobToken });
    if (before.hasMore || before.blobs.length !== 0) {
      throw new Error(
        "The Vercel hosted proof requires an empty dedicated Blob store.",
      );
    }
    const baseline = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM emails) AS emails,
         (
           SELECT count(*)::int
           FROM app_entities
           WHERE kind = 'attachment_upload'
         ) AS attachments`,
    );
    if (
      baseline.rows[0]?.emails !== 0 ||
      baseline.rows[0]?.attachments !== 0
    ) {
      throw new Error(
        "The Vercel hosted Blob proof requires an empty application database.",
      );
    }

    const declaration = await api(apiOrigin, apiKey, "/attachments", {
      method: "POST",
      body: JSON.stringify({
        filename: "proof.txt",
        content_type: "text/plain",
        size_bytes: CONTENT.byteLength,
        checksum_sha256: CHECKSUM,
      }),
    });
    attachmentId = declaration.id;
    const uploadUrl = assertUpload(declaration, apiOrigin);
    const uploaded = await fetch(uploadUrl, {
      method: "PUT",
      headers: declaration.upload_headers,
      body: CONTENT,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!uploaded.ok) {
      throw new Error(
        `Private Blob signed upload returned ${uploaded.status}.`,
      );
    }
    const replay = await fetch(uploadUrl, {
      method: "PUT",
      headers: declaration.upload_headers,
      body: CONTENT,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (replay.ok) {
      throw new Error("Private Blob signed upload allowed overwrite.");
    }

    const inventory = await list({ limit: 2, token: blobToken });
    if (inventory.hasMore || inventory.blobs.length !== 1) {
      throw new Error("Private Blob inventory is not singular.");
    }
    const blob = inventory.blobs[0];
    if (blob.size !== CONTENT.byteLength) {
      throw new Error("Private Blob size does not match the declaration.");
    }
    const unauthenticated = await fetch(blob.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (![401, 403, 404].includes(unauthenticated.status)) {
      throw new Error("Private Blob content is publicly readable.");
    }
    const downloaded = await get(blob.pathname, {
      access: "private",
      token: blobToken,
    });
    if (!downloaded?.stream || downloaded.statusCode !== 200) {
      throw new Error("Authenticated private Blob read failed.");
    }
    const bytes = await streamBytes(
      downloaded.stream,
      CONTENT.byteLength,
    );
    if (
      createHash("sha256").update(bytes).digest("hex") !== CHECKSUM
    ) {
      throw new Error("Private Blob byte-level checksum verification failed.");
    }

    const accepted = await api(apiOrigin, apiKey, "/emails", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        from: "HayaSend Proof <proof-sender@example.com>",
        to: ["proof-recipient@example.net"],
        subject: "HayaSend Vercel private Blob proof",
        text: "Isolated console-only private attachment proof.",
        attachments: [{ attachment_id: attachmentId }],
      }),
    });
    if (!EMAIL_ID_PATTERN.test(accepted?.id ?? "")) {
      throw new Error("Hosted Blob proof email identity is invalid.");
    }
    emailId = accepted.id;

    const deadline = Date.now() + 180_000;
    let retrieved;
    while (Date.now() < deadline) {
      retrieved = await api(
        apiOrigin,
        apiKey,
        `/emails/${emailId}`,
      );
      if (retrieved?.status === "sent") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (
      retrieved?.status !== "sent" ||
      !Array.isArray(retrieved.attachments) ||
      retrieved.attachments.length !== 1 ||
      retrieved.attachments[0]?.attachment_id !== attachmentId ||
      retrieved.attachments[0]?.filename !== "proof.txt" ||
      retrieved.attachments[0]?.content_type !== "text/plain"
    ) {
      throw new Error(
        "The deployed worker did not consume the private attachment.",
      );
    }
    const delivery = await pool.query(
      `SELECT
         email.entity->>'status' AS email_status,
         recipient.entity->>'status' AS recipient_status,
         attempt.entity->>'status' AS attempt_status,
         attempt.provider
       FROM emails AS email
       JOIN delivery_recipients AS recipient
         ON recipient.message_id = email.id
       JOIN delivery_attempts AS attempt
         ON attempt.message_id = email.id
       WHERE email.id = $1`,
      [emailId],
    );
    if (
      delivery.rows.length !== 1 ||
      delivery.rows[0]?.email_status !== "sent" ||
      delivery.rows[0]?.recipient_status !== "accepted" ||
      delivery.rows[0]?.attempt_status !== "accepted" ||
      delivery.rows[0]?.provider !== "portable-console"
    ) {
      throw new Error(
        "Private attachment delivery did not converge in the recipient ledger.",
      );
    }
    proofComplete = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (!emailId) {
        emailId = await resolveEmailId(pool, idempotencyKey);
      }
      if (!attachmentId) {
        attachmentId = await resolveAttachmentId(pool);
      }
      await cleanupDatabase(pool, emailId, attachmentId);
      await emptyProofStore(blobToken);
    } catch (cleanupError) {
      failure ??= cleanupError;
      proofComplete = false;
    } finally {
      await pool.end();
    }
  }

  if (failure || !proofComplete || !emailId || !attachmentId) {
    throw new Error("Vercel private Blob hosted proof failed.");
  }
  const evidence = {
    object: "vercel_private_blob_hosted_proof",
    schema_version: "1.0.0",
    api_origin_sha256: createHash("sha256")
      .update(apiOrigin.origin)
      .digest("hex"),
    signed_put_bound_to_exact_object: true,
    overwrite_refused: true,
    public_read_refused: true,
    authenticated_private_read: true,
    byte_length_verified: true,
    sha256_verified: true,
    worker_consumed_attachment: true,
    email_state: "sent",
    recipient_state: "accepted",
    provider_attempt_state: "accepted",
    provider: "portable-console",
    external_send_performed: false,
    terminal_delivery_claimed: false,
    cleanup: {
      database_fixture_rows_remaining: 0,
      blob_objects_remaining: 0,
      complete: true,
    },
    privacy: {
      credentials_included: false,
      addresses_included: false,
      content_included: false,
      signed_urls_included: false,
      raw_errors_included: false,
    },
  };
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

try {
  await main();
} catch {
  process.stderr.write("Vercel private Blob hosted proof failed.\n");
  process.exitCode = 1;
}
