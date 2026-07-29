const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const source = Buffer.concat(chunks).toString("utf8");

const proofs = [];

function objectEnd(start) {
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

for (let start = 0; start < source.length; start += 1) {
  if (source[start] !== "{") {
    continue;
  }
  const end = objectEnd(start);
  if (end === undefined) {
    continue;
  }
  try {
    const candidate = JSON.parse(source.slice(start, end));
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      candidate.object === "portable_hosted_semantic_proof"
    ) {
      proofs.push(candidate);
    }
    start = end - 1;
  } catch {
    // A log prefix can contain braces. Continue at the next opening brace.
  }
}

if (proofs.length !== 1) {
  throw new Error(
    `Expected exactly one portable hosted proof in the selected log stream; found ${proofs.length}.`,
  );
}

process.stdout.write(`${JSON.stringify(proofs[0], null, 2)}\n`);
