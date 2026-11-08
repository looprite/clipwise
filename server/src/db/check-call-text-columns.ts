// Check for db/call-text-columns.ts (SAA-277 step 2): the column types that
// encrypt call text on the way into the database and decrypt it on the way out,
// and the sealing of the text fields inside the two metadata columns. No
// database, no network. The key is a throwaway one made in this process.
//
//   npx tsx src/db/check-call-text-columns.ts

import { randomBytes } from "node:crypto";
import { pgTable } from "drizzle-orm/pg-core";
import { isEncryptedCallText } from "../lib/call-text.js";
import {
  encryptedText,
  momentMetadata,
  openMomentMetadata,
  openRecordingMetadata,
  recordingMetadata,
  sealMomentMetadata,
  sealRecordingMetadata,
} from "./call-text-columns.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
process.env.CALL_TEXT_KEY = KEY_A;

const PHRASE = "zebra lantern quarterly";
const NAME = "Ottoline Prewett";

// ---- the text column, through drizzle's own mapping ----
const t = pgTable("check_call_text", { x: encryptedText("x") });
const toDb = t.x.mapToDriverValue(PHRASE) as string;
check("encryptedText writes the encrypted shape", isEncryptedCallText(toDb), String(toDb).slice(0, 16));
check("encryptedText writes no plaintext", !toDb.includes("zebra"));
check("encryptedText reads back the text", t.x.mapFromDriverValue(toDb) === PHRASE);
check("encryptedText reads a plain (not yet backfilled) value as it is", t.x.mapFromDriverValue(PHRASE) === PHRASE);
check("encryptedText's SQL type is text", t.x.getSQLType() === "text", t.x.getSQLType());

// ---- moment metadata ----
const moment = {
  source: "extracted",
  extraction_run: "11111111-2222-3333-4444-555555555555",
  span_label: `Budget: ${PHRASE}`,
  span_segment_range: [3, 9],
  speakers: [NAME, "them"],
  collapsed_into: "66666666-7777-8888-9999-000000000000",
  merged_from: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
  offsets_clamped: true,
};
const sealedMoment = sealMomentMetadata(moment) as Record<string, unknown>;
check("moment: span_label is sealed", typeof sealedMoment.span_label === "string" && isEncryptedCallText(sealedMoment.span_label));
check("moment: speakers is sealed", typeof sealedMoment.speakers === "string" && isEncryptedCallText(sealedMoment.speakers));
check("moment: the sealed JSON holds neither the topic nor a speaker's name", !JSON.stringify(sealedMoment).includes("zebra") && !JSON.stringify(sealedMoment).includes("Prewett"));
check("control: the containment test finds them in the open metadata", JSON.stringify(moment).includes("zebra") && JSON.stringify(moment).includes("Prewett"));
const structural = ["source", "extraction_run", "span_segment_range", "collapsed_into", "merged_from", "offsets_clamped"] as const;
check("moment: the keys searches filter on are left as they were", structural.every((k) => same(sealedMoment[k], moment[k])), JSON.stringify(sealedMoment));
check("moment: open gives back the original", same(openMomentMetadata(sealedMoment), moment));
check("moment: sealing twice is sealing once (an already-sealed value is kept)", same(sealMomentMetadata(sealedMoment), sealedMoment));
check("moment: the input object is not changed by sealing", same(moment.speakers, [NAME, "them"]) && moment.span_label.includes("zebra"));
check("moment: plain metadata (before the backfill) opens to itself", same(openMomentMetadata(moment), moment));
check("moment: metadata without span_label or speakers is unchanged", same(sealMomentMetadata({ source: "hand_curated" }), { source: "hand_curated" }));
check("moment: a null span_label stays null", (sealMomentMetadata({ span_label: null }) as Record<string, unknown>).span_label === null);
check("moment: null and non-object metadata pass through", sealMomentMetadata(null) === null && openMomentMetadata(null) === null && sealMomentMetadata(5) === 5);

// ---- recording metadata ----
const recording = {
  transcription_engine: "parakeet",
  capture: { stem: "2026-11-08-1000", content_hash: "abc" },
  capture_quality: {
    verdict: "partial",
    reason: "tap silent",
    dropped_segments: [
      { track: "them", start_ms: 0, end_ms: 900, text: `and the ${PHRASE} line` },
      { track: "them", start_ms: 1000, end_ms: 1800, text: "" },
    ],
  },
  identity: { guests: [{ name: NAME }] },
  current_extraction_run: "11111111-2222-3333-4444-555555555555",
};
const sealedRecording = sealRecordingMetadata(recording) as typeof recording;
const dropped = sealedRecording.capture_quality.dropped_segments;
check("recording: every dropped segment's text is sealed", dropped.every((s) => isEncryptedCallText(s.text)), JSON.stringify(dropped));
check("recording: the sealed JSON holds no dropped speech", !JSON.stringify(sealedRecording).includes("zebra"));
check("recording: track and times of a dropped segment are left readable", dropped[0].track === "them" && dropped[0].start_ms === 0 && dropped[0].end_ms === 900);
check("recording: everything outside the dropped text is left as it was (names stay plain, by decision)", same({ ...sealedRecording, capture_quality: { ...sealedRecording.capture_quality, dropped_segments: null } }, { ...recording, capture_quality: { ...recording.capture_quality, dropped_segments: null } }));
check("recording: open gives back the original", same(openRecordingMetadata(sealedRecording), recording));
check("recording: sealing twice is sealing once", same(sealRecordingMetadata(sealedRecording), sealedRecording));
check("recording: metadata with no capture_quality, or none at all, is unchanged", same(sealRecordingMetadata({ identity: {} }), { identity: {} }) && sealRecordingMetadata(null) === null);
check("recording: a capture_quality with dropped_segments null is unchanged", same(sealRecordingMetadata({ capture_quality: { dropped_segments: null } }), { capture_quality: { dropped_segments: null } }));

// ---- the jsonb columns, through drizzle's own mapping ----
const j = pgTable("check_call_text_meta", { m: momentMetadata("m"), r: recordingMetadata("r") });
const mOut = j.m.mapToDriverValue(moment) as string;
check("momentMetadata writes JSON text with the fields sealed", typeof mOut === "string" && !mOut.includes("zebra") && JSON.parse(mOut).source === "extracted");
check("momentMetadata reads pg's parsed jsonb (an object) back open", same(j.m.mapFromDriverValue(JSON.parse(mOut)), moment));
check("momentMetadata reads a JSON string back open too", same(j.m.mapFromDriverValue(mOut), moment));
const rOut = j.r.mapToDriverValue(recording) as string;
check("recordingMetadata writes JSON text with the dropped speech sealed", typeof rOut === "string" && !rOut.includes("zebra"));
check("recordingMetadata reads back open", same(j.r.mapFromDriverValue(JSON.parse(rOut)), recording));
check("the jsonb columns' SQL type is jsonb", j.m.getSQLType() === "jsonb" && j.r.getSQLType() === "jsonb");

// ---- the wrong key ----
process.env.CALL_TEXT_KEY = KEY_B;
let refused = false;
try {
  openMomentMetadata(sealedMoment);
} catch {
  refused = true;
}
check("control: metadata sealed under one key does not open under another", refused);
process.env.CALL_TEXT_KEY = KEY_A;

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
