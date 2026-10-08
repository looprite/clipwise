// Regression check for the transcript pager (SAA-226). Made-up segments only
// (Architecture Decision 11); no database. Same plain-script/exit-code shape as
// check-assign-voice.ts.
//
// The invariant that matters: walking `next` from the start returns every
// segment exactly once, whatever the budget — including segments that share a
// start time, and empty ones.
//
// Usage:
//   tsx src/services/check-transcript-page.ts

import type { FileSegment } from "../lib/transcript-file.js";
import { DEFAULT_PAGE_CHARS, MAX_PAGE_CHARS, MIN_PAGE_CHARS, clampPageChars, pageTranscript, type Page } from "./transcript-page.js";

let failed = 0;
let total = 0;
function check(name: string, ok: boolean, detail = ""): void {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
}

const seg = (i: number, text: string, label = i % 2 ? "me" : "them", startSec = i * 3): FileSegment => ({
  startSec,
  endSec: startSec + 2.5,
  text,
  speakerLabel: label,
  speakerDisplayName: label === "me" ? "Jon Dwyer" : "Colette",
});

// 400 segments of ~300 characters: ~125,000 characters rendered.
const filler = "word ".repeat(60).trim();
const big: FileSegment[] = Array.from({ length: 400 }, (_, i) => seg(i, `${filler} ${i}`));

function walk(segments: FileSegment[], maxChars: number, extra: { fromSec?: number; toSec?: number } = {}): { pages: Page[]; seen: number[] } {
  const pages: Page[] = [];
  const seen: number[] = [];
  let cursor: number | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = pageTranscript(segments, null, { maxChars, fromSegment: cursor, ...(cursor === undefined ? extra : { toSec: extra.toSec }) });
    pages.push(page);
    for (let i = page.first ?? 0; page.first !== null && i <= (page.last ?? -1); i++) {
      if (page.text.includes(`[#${i} `)) seen.push(i);
    }
    if (!page.next) break;
    cursor = page.next.fromSegment;
  }
  return { pages, seen };
}

const whole = pageTranscript(big, null, { maxChars: MAX_PAGE_CHARS });
check("a ~125k-character transcript does not fit one page even at the maximum budget", whole.next !== null && whole.totalChars > MAX_PAGE_CHARS, `totalChars ${whole.totalChars}`);

for (const budget of [1_000, 5_000, DEFAULT_PAGE_CHARS, MAX_PAGE_CHARS]) {
  const { pages, seen } = walk(big, budget);
  const exactlyOnce = seen.length === big.length && seen.every((v, i) => v === i);
  check(`budget ${budget}: walking next returns every segment exactly once (${pages.length} page(s))`, exactlyOnce, `saw ${seen.length}, ${new Set(seen).size} distinct`);
  const over = pages.filter((p) => p.shown > 1 && p.text.length > budget);
  check(`budget ${budget}: no page with more than one line exceeds the budget`, over.length === 0, `${over.length} over`);
}

const dupStart: FileSegment[] = Array.from({ length: 60 }, (_, i) => seg(i, `${filler} ${i}`, "them", Math.floor(i / 3) * 5));
const dup = walk(dupStart, 1_000);
check("segments sharing a start time are neither repeated nor skipped", dup.seen.length === 60 && dup.seen.every((v, i) => v === i), `saw ${dup.seen.length}`);

const withEmpty = [seg(0, "hello"), seg(1, "   "), seg(2, "\n\t"), seg(3, "world")];
const e = pageTranscript(withEmpty, null);
check("empty and whitespace-only segments are skipped but keep their numbers", e.shown === 2 && e.text.includes("[#0 ") && e.text.includes("[#3 ") && !e.text.includes("[#1 "), e.text);

const one = pageTranscript([seg(0, "x".repeat(5_000))], null, { maxChars: 1_000 });
check("a single segment longer than the budget is still returned whole (the walk cannot stall)", one.shown === 1 && one.next === null && one.text.length > 5_000);

const small = pageTranscript([seg(0, "hi"), seg(1, "there")], null);
check("a short transcript is one page with no next", small.shown === 2 && small.next === null && small.first === 0 && small.last === 1);

check("an empty transcript is an empty page", pageTranscript([], null).shown === 0 && pageTranscript([], null).next === null);

const t = pageTranscript(big, null, { fromSec: 30 });
check("fromSec starts at the first segment still running at that second", t.first === 10 && t.text.startsWith("[#10 0:30]"), t.text.slice(0, 40));

const mid = pageTranscript(big, null, { fromSec: 31, maxChars: 2_000 });
check("fromSec inside a segment starts with that segment, not the next", mid.first === 10);

const windowed = walk(big, 5_000, { fromSec: 30, toSec: 90 });
check("fromSec + toSec bound the walk (segments 10–29) and it still ends", windowed.seen.length === 20 && windowed.seen[0] === 10 && windowed.seen[19] === 29, `${windowed.seen[0]}..${windowed.seen[windowed.seen.length - 1]} (${windowed.seen.length})`);

check("fromSec past the end is an empty page", pageTranscript(big, null, { fromSec: 99_999 }).shown === 0);
check("fromSegment past the end is an empty page, below zero starts at zero", pageTranscript(big, null, { fromSegment: 999 }).shown === 0 && pageTranscript(big, null, { fromSegment: -5 }).first === 0);

check("the budget is clamped to the allowed range", clampPageChars(10) === MIN_PAGE_CHARS && clampPageChars(10_000_000) === MAX_PAGE_CHARS && clampPageChars(undefined) === DEFAULT_PAGE_CHARS && clampPageChars(NaN) === DEFAULT_PAGE_CHARS);

const named = pageTranscript([seg(0, "a", "me"), seg(1, "b", "Voice 2"), seg(2, "c", "them")], "Host Name");
check("speaker names follow the saved-transcript rules, resolved over the whole recording", /\] Jon Dwyer: a/.test(named.text) && /Unnamed voice|Unattributed|Colette/.test(named.text), named.text);

const later = pageTranscript(big, null, { fromSegment: 300, maxChars: 2_000 });
check("names are worked out over the whole recording, so a later page names speakers the same way", later.text.startsWith("[#300 15:00] Jon Dwyer:") || later.text.startsWith("[#300 15:00] Colette:"), later.text.slice(0, 40));

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
