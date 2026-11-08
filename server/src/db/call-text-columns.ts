// The column types that keep call text encrypted at rest (SAA-277). Drizzle
// calls toDriver on every value it writes through one of these columns (inserts
// and updates) and fromDriver on every value it reads back (selects and
// returning), so reading and writing through the ORM need no change. It skips
// both for null (drizzle-orm utils.js mapResultRow, sql/sql.js on a Param).
//
// Comparisons on these columns never match, through Drizzle or not: eq, ne,
// like, ilike, inArray, orderBy and groupBy all compare stored ciphertext, and
// each write uses a random IV, so the same text is stored differently every time.
// (Drizzle even encrypts the value given to eq or like, freshly, so it equals no
// stored row.) Search, filter, sort and group on call text in the server, after
// reading it. The same holds inside the metadata for span_label, speakers and the
// dropped text, below.
//
// Raw SQL (pool.query, db.execute, a column interpolated into sql``) does not go
// through these types: it sees the stored shape, cw1:<key id>:<…>, so a length
// or comparison on it is meaningless. A raw read of call text has to decrypt
// with lib/call-text.ts itself, or go through the ORM.
//
// Inside the two metadata columns only the call-text fields are sealed; the keys
// searches filter on stay readable by SQL:
//   moments.metadata     span_label (the topic tag) and speakers (names as the
//                        model cited them); source, extraction_run,
//                        collapsed_into, merged_from and the rest stay plain.
//   recordings.metadata  capture_quality.dropped_segments[].text (verbatim speech
//                        the classifier excluded); everything else stays plain,
//                        the identity answer's names included (names are out of
//                        scope by decision, SAA-277 2026-11-08 item 1).
// Sealing is idempotent: a field already in the encrypted shape is kept as it is,
// so an ORM update that writes back metadata it read is safe, and so is one that
// writes back metadata it got from raw SQL.

import { customType } from "drizzle-orm/pg-core";
import { decryptCallText, encryptCallText, isEncryptedCallText, type CallTextKey } from "../lib/call-text.js";

export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    return encryptCallText(value);
  },
  fromDriver(value) {
    return decryptCallText(value);
  },
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
// The seal functions take the key from the environment unless given one (the
// backfill passes the key it loaded).
const sealString = (v: string, key?: CallTextKey): string => (isEncryptedCallText(v) ? v : encryptCallText(v, key));

// ---- moments.metadata ----

export function sealMomentMetadata(meta: unknown, key?: CallTextKey): unknown {
  if (!isObj(meta)) return meta;
  const out: Obj = { ...meta };
  if (typeof out.span_label === "string") out.span_label = sealString(out.span_label, key);
  // Any JSON value, sealed as its JSON text; a string already sealed is kept.
  if (out.speakers !== undefined && out.speakers !== null && !(typeof out.speakers === "string" && isEncryptedCallText(out.speakers))) {
    out.speakers = encryptCallText(JSON.stringify(out.speakers), key);
  }
  return out;
}

export function openMomentMetadata(meta: unknown): unknown {
  if (!isObj(meta)) return meta;
  const out: Obj = { ...meta };
  if (typeof out.span_label === "string") out.span_label = decryptCallText(out.span_label);
  if (typeof out.speakers === "string" && isEncryptedCallText(out.speakers)) out.speakers = JSON.parse(decryptCallText(out.speakers));
  return out;
}

// ---- recordings.metadata ----

function mapDropped(meta: unknown, fn: (text: string) => string): unknown {
  if (!isObj(meta) || !isObj(meta.capture_quality) || !Array.isArray(meta.capture_quality.dropped_segments)) return meta;
  const dropped = meta.capture_quality.dropped_segments.map((s: unknown) =>
    isObj(s) && typeof s.text === "string" ? { ...s, text: fn(s.text) } : s,
  );
  return { ...meta, capture_quality: { ...meta.capture_quality, dropped_segments: dropped } };
}

export const sealRecordingMetadata = (meta: unknown, key?: CallTextKey): unknown => mapDropped(meta, (v) => sealString(v, key));
export const openRecordingMetadata = (meta: unknown): unknown => mapDropped(meta, decryptCallText);

// ---- the two jsonb columns ----
// toDriver gives JSON text, as drizzle's own jsonb does (pg-core/columns/jsonb.js);
// fromDriver takes what pg hands back for jsonb (already parsed), or a JSON string.

function sealedJsonb(seal: (m: unknown) => unknown, open: (m: unknown) => unknown) {
  return customType<{ data: unknown; driverData: unknown }>({
    dataType() {
      return "jsonb";
    },
    toDriver(value) {
      return JSON.stringify(seal(value));
    },
    fromDriver(value) {
      return open(typeof value === "string" ? JSON.parse(value) : value);
    },
  });
}

export const momentMetadata = sealedJsonb(sealMomentMetadata, openMomentMetadata);
export const recordingMetadata = sealedJsonb(sealRecordingMetadata, openRecordingMetadata);
