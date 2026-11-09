// Encryption of stored call text (SAA-277): segment and transcript text, moment
// titles and summaries, recording titles, and the text fields inside the
// metadata. AES-256-GCM, with a key kept outside the database as a host secret
// (CALL_TEXT_KEY, a Fly secret in production). Separate from lib/crypto.ts and
// its CALENDAR_TOKEN_ENCRYPTION_KEY on purpose: a different key, so neither can
// open the other's rows, and a stored shape that names its key.
//
// Stored shape:  cw1:<key id>:<base64 of iv(12) | tag(16) | ciphertext>
//
// The key id is the first 8 hex characters of SHA-256 over the 32 raw key bytes.
// It is not secret. It says which key a row needs, so a wrong key is refused by
// name instead of by a bare GCM failure, and it lets production check that it
// holds the key it was told to expect (CALL_TEXT_KEY_ID), and a scratch run check
// that it does not.
//
// A value that is not in the stored shape is refused (CallTextKeyError), not
// returned as it is: every value is encrypted at rest since the backfill
// (db/encrypt-call-text.ts) left none plain on main, so a plain one can only
// have been written behind the column types' back. The backfill never decrypts:
// it finds plain values in SQL and only encrypts them.
//
// Nothing here puts the text or the key into an error message.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const CALL_TEXT_PREFIX = "cw1:";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STORED = /^cw1:([0-9a-f]{8}):([A-Za-z0-9+/]+={0,2})$/;

export type CallTextKey = { readonly id: string; readonly bytes: Buffer };

// Every refusal below: a missing or malformed key, a key id that is not the one
// expected, a value under another key, or one that fails authentication. Its
// message names variables and key ids only, never text or a key, so a caller
// that prints errors with care (db/encrypt-call-text.ts) can print this class's
// message and nothing else's.
export class CallTextKeyError extends Error {
  override name = "CallTextKeyError";
}

export function keyIdOf(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

// From an environment (process.env by default). Read on each call rather than
// once at module load, like lib/crypto.ts, so this module imports before the
// variable exists.
export function loadCallTextKey(env: Record<string, string | undefined> = process.env): CallTextKey {
  const encoded = (env.CALL_TEXT_KEY ?? "").trim();
  if (!encoded) throw new CallTextKeyError("CALL_TEXT_KEY not set. Generate one with: openssl rand -base64 32");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new CallTextKeyError("CALL_TEXT_KEY is not base64. Generate one with: openssl rand -base64 32");
  if (bytes.length !== KEY_BYTES) throw new CallTextKeyError(`CALL_TEXT_KEY must decode to ${KEY_BYTES} bytes; got ${bytes.length}`);
  const id = keyIdOf(bytes);
  const expected = (env.CALL_TEXT_KEY_ID ?? "").trim();
  if (expected && expected !== id) throw new CallTextKeyError(`CALL_TEXT_KEY has id ${id}, but CALL_TEXT_KEY_ID expects ${expected}`);
  return { id, bytes };
}

// Whether a stored value is in the encrypted shape. Speech that merely starts
// with "cw1:" is not: the whole value has to be the prefix, an 8-hex key id and
// one base64 body. A value in this shape is never passed through as plaintext:
// decryptCallText opens it or refuses it, so a damaged one is an error, not text.
export function isEncryptedCallText(value: string): boolean {
  return STORED.test(value);
}

export function encryptCallText(plaintext: string, key: CallTextKey = loadCallTextKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const body = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  return `${CALL_TEXT_PREFIX}${key.id}:${body}`;
}

export function decryptCallText(stored: string, key: CallTextKey = loadCallTextKey()): string {
  if (!isEncryptedCallText(stored)) throw new CallTextKeyError("call text is stored in plain, not encrypted; run db/encrypt-call-text.ts");
  const [, id, body] = STORED.exec(stored)!;
  if (id !== key.id) throw new CallTextKeyError(`call text was encrypted with key ${id}; the key loaded is ${key.id}`);
  const raw = Buffer.from(body, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new CallTextKeyError(`call text under key ${id} is too short to hold its IV and tag (truncated)`);
  const decipher = createDecipheriv(ALGORITHM, key.bytes, raw.subarray(0, IV_BYTES));
  // No associated data: the id is derived from the key, so a value relabelled
  // with another key's id opens with that key's bytes and fails on the tag.
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new CallTextKeyError(`call text under key ${id} failed authentication (altered or truncated)`);
  }
}
