import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as sha256Digest } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  utf8Bytes,
} from "./bytes.js";

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function sha256(value: string): string {
  return bytesToHex(sha256Digest(utf8ToBytes(value)));
}

export function sha256Bytes(value: Uint8Array): string {
  return bytesToHex(sha256Digest(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function requestHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function secretsEqual(left: string, right: string): boolean {
  const leftBytes = utf8Bytes(left);
  const rightBytes = utf8Bytes(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function createWebhookSecret(): string {
  return `whsec_${bytesToBase64(randomBytes(32))}`;
}

export function signWebhook(
  secret: string,
  id: string,
  timestamp: string,
  payload: string,
): string {
  const encodedSecret = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  const secretBytes = base64ToBytes(encodedSecret);
  const signature = bytesToBase64(
    hmac(
      sha256Digest,
      secretBytes,
      utf8ToBytes(`${id}.${timestamp}.${payload}`),
    ),
  );
  return `v1,${signature}`;
}

export function createRandomToken(byteLength = 32): string {
  return bytesToBase64Url(randomBytes(byteLength));
}
