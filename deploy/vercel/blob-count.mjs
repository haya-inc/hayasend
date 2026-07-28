import { list } from "@vercel/blob";

let cursor;
let count = 0;
do {
  const page = await list({
    cursor,
    limit: 1000,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  count += page.blobs.length;
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

process.stdout.write(`${JSON.stringify({ count })}\n`);
