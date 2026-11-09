// Check for lib/call-text.ts, the encryption of stored call text (SAA-277). No
// database, no network, no real key: every key here is made in this process and
// thrown away.
//
//   npx tsx src/lib/check-call-text.ts
//
// It also runs the key-id command an operator uses on a new key (base64 -d |
// shasum -a 256) on a throwaway key, so the id read off a terminal is the one
// the server computes.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  CALL_TEXT_PREFIX,
  CallTextKeyError,
  decryptCallText,
  encryptCallText,
  isEncryptedCallText,
  keyIdOf,
  loadCallTextKey,
  type CallTextKey,
} from "./call-text.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}
function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const rawA = randomBytes(32);
const rawB = randomBytes(32);
const b64A = rawA.toString("base64");
const keyA: CallTextKey = loadCallTextKey({ CALL_TEXT_KEY: b64A });
const keyB: CallTextKey = loadCallTextKey({ CALL_TEXT_KEY: rawB.toString("base64") });

// ---- round trips ----
const samples: Array<[string, string]> = [
  ["plain speech", "We agreed to ship the beta to five hundred people on the ninth."],
  ["unicode (accents, CJK, emoji)", "Zoë said 「了解」 and then 👍🏽"],
  ["empty string", ""],
  ["100,000 characters", "word ".repeat(20000)],
];
for (const [name, text] of samples) {
  const stored = encryptCallText(text, keyA);
  check(`round trip: ${name}`, decryptCallText(stored, keyA) === text);
}
check("control: the round-trip comparison notices a one-character difference", decryptCallText(encryptCallText("abc", keyA), keyA) !== "abd");

// ---- the stored shape ----
const PHRASE = "the purple giraffe budget";
const stored = encryptCallText(PHRASE, keyA);
check(`stored value starts with ${CALL_TEXT_PREFIX}<key id>:`, stored.startsWith(`${CALL_TEXT_PREFIX}${keyA.id}:`), stored.slice(0, 16));
check("stored value does not contain the plaintext", !stored.includes(PHRASE) && !stored.toLowerCase().includes("giraffe"));
check("control: the containment test finds the phrase when it is there", `x${PHRASE}x`.includes(PHRASE));
check("two encryptions of the same text differ (random IV)", encryptCallText(PHRASE, keyA) !== encryptCallText(PHRASE, keyA));
check("isEncryptedCallText: true for a stored value", isEncryptedCallText(stored));

// ---- a plain value is refused (strict, once the backfill left none) ----
// The class, and a message that holds none of the value.
const refusedPlain = (value: string): { ok: boolean; detail: string } => {
  try {
    decryptCallText(value, keyA);
    return { ok: false, detail: "not refused" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const words = value.split(/\s+/).filter((w) => w.length > 3);
    return { ok: err instanceof CallTextKeyError && !words.some((w) => msg.includes(w)), detail: `${err instanceof Error ? err.constructor.name : typeof err}: ${msg}` };
  }
};
check("isEncryptedCallText: false for plain speech", !isEncryptedCallText(PHRASE));
const plain = refusedPlain(PHRASE);
check("a plain value is refused with CallTextKeyError, and the message holds none of it", plain.ok, plain.detail);
const lookalike = "cw1: so the first thing on the list is pricing";
const look = refusedPlain(lookalike);
check("speech that happens to start with cw1: is not taken for ciphertext, and is refused as plain", !isEncryptedCallText(lookalike) && look.ok, look.detail);
const empty = refusedPlain("");
check("an empty plain string is refused too (an empty value is stored encrypted)", empty.ok, empty.detail);
check("control: the empty string stored encrypted still opens", decryptCallText(encryptCallText("", keyA), keyA) === "");
check("isEncryptedCallText: false for the prefix and a key id with no body", !isEncryptedCallText(`${CALL_TEXT_PREFIX}${keyA.id}:`));

// ---- refusals, and what they say ----
const leaks = (msg: string | null) => msg !== null && (msg.includes(PHRASE) || msg.includes("giraffe") || msg.includes(b64A));
const wrongKey = thrown(() => decryptCallText(stored, keyB));
check("the wrong key is refused", wrongKey !== null);
check("the wrong-key refusal names both key ids", wrongKey !== null && wrongKey.includes(keyA.id) && wrongKey.includes(keyB.id), wrongKey ?? "");
check("the wrong-key refusal holds neither the text nor the key", !leaks(wrongKey), wrongKey ?? "");

const body = stored.slice(stored.lastIndexOf(":") + 1);
const bytes = Buffer.from(body, "base64");
bytes[bytes.length - 1] ^= 0x01;
const tampered = `${CALL_TEXT_PREFIX}${keyA.id}:${bytes.toString("base64")}`;
const tamperMsg = thrown(() => decryptCallText(tampered, keyA));
check("a value with one flipped bit is refused", tamperMsg !== null);
check("the tamper refusal holds neither the text nor the key", !leaks(tamperMsg), tamperMsg ?? "");

const forgedId = stored.replace(`${CALL_TEXT_PREFIX}${keyA.id}:`, `${CALL_TEXT_PREFIX}${keyB.id}:`);
check("a value relabelled with another key's id is refused even with that key", thrown(() => decryptCallText(forgedId, keyB)) !== null);
const truncated = `${CALL_TEXT_PREFIX}${keyA.id}:${Buffer.alloc(20).toString("base64")}`;
check("a body shorter than IV and tag is refused", thrown(() => decryptCallText(truncated, keyA)) !== null);

// ---- the key id ----
check("key id is 8 lowercase hex characters", /^[0-9a-f]{8}$/.test(keyA.id), keyA.id);
check("key id is stable for the same key", keyIdOf(rawA) === keyA.id && loadCallTextKey({ CALL_TEXT_KEY: b64A }).id === keyA.id);
check("different keys have different ids", keyA.id !== keyB.id);
const shellId = execFileSync("/bin/sh", ["-c", "base64 -d | shasum -a 256 | cut -c1-8"], { input: b64A, encoding: "utf8" }).trim();
check("the hand step's command (base64 -d | shasum -a 256 | cut -c1-8) gives the server's key id", shellId === keyA.id, `shell ${shellId}, server ${keyA.id}`);

// ---- loading the key ----
const missing = thrown(() => loadCallTextKey({}));
check("no CALL_TEXT_KEY is refused, by name", missing !== null && missing.includes("CALL_TEXT_KEY"), missing ?? "");
const short = thrown(() => loadCallTextKey({ CALL_TEXT_KEY: randomBytes(16).toString("base64") }));
check("a 16-byte key is refused", short !== null);
const junk = thrown(() => loadCallTextKey({ CALL_TEXT_KEY: "not base64 at all, but forty-four characters!" }));
check("a value that is not base64 is refused", junk !== null);
check("a key with surrounding whitespace (a pasted newline) loads to the same key", loadCallTextKey({ CALL_TEXT_KEY: `${b64A}\n` }).id === keyA.id);
check("CALL_TEXT_KEY_ID that matches the key loads", thrown(() => loadCallTextKey({ CALL_TEXT_KEY: b64A, CALL_TEXT_KEY_ID: keyA.id })) === null);
const mismatch = thrown(() => loadCallTextKey({ CALL_TEXT_KEY: b64A, CALL_TEXT_KEY_ID: keyB.id }));
check("CALL_TEXT_KEY_ID that does not match the key is refused", mismatch !== null);
check("the mismatch refusal names both ids and not the key", mismatch !== null && mismatch.includes(keyA.id) && mismatch.includes(keyB.id) && !mismatch.includes(b64A), mismatch ?? "");

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
