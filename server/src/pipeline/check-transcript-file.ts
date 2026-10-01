// Regression check for the saved transcript file (SAA-199): layout, speaker
// labels, the Unnamed voice / Unattributed distinction. Made-up samples only
// (Architecture Decision 11); no database. Same plain-script, exit-code shape
// as check-assign-voice.ts.
//
// Usage:
//   tsx src/pipeline/check-transcript-file.ts

import {
  buildTurns,
  formatTimestamp,
  formatTranscriptFile,
  suggestedFileName,
  type FileSegment,
} from "../lib/transcript-file.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail}`}`);
  if (!ok) failed++;
}

const seg = (startSec: number, text: string, label: string | null, name: string | null = null): FileSegment => ({
  startSec,
  endSec: startSec + 2,
  text,
  speakerLabel: label,
  speakerDisplayName: name,
});

// The search a reader runs over a file: any turn header whose speaker is a
// bare track or voice label.
export function badSpeakerLabels(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^\d+:\d{2}(:\d{2})? - /.test(l))
    .map((l) => l.replace(/^\d+:\d{2}(:\d{2})? - /, ""))
    .filter((n) => /^(me|them|Voice \d+)$/i.test(n));
}

const when = new Date("2026-03-02T15:00:00Z"); // a Monday, made up
const base = { title: "Made-Up Sync", startedAt: when, durationSec: 840 };

// 1. Layout, interleave by start time, consecutive lines of one speaker joined.
{
  const text = formatTranscriptFile(
    {
      ...base,
      segments: [
        seg(8, "Second thing.", "Voice 1", "Alice Example"),
        seg(0, "Hello there.", "me", "Jon Example"),
        seg(5, "First thing.", "Voice 1", "Alice Example"),
        seg(65, "Later on.", "me", "Jon Example"),
      ],
    },
    "UTC",
  );
  const want =
    "Made-Up Sync\nMarch 2, 2026 · 14 mins\n\n---\n\n" +
    "0:00 - Jon Example\n  Hello there.\n\n" +
    "0:05 - Alice Example\n  First thing. Second thing.\n\n" +
    "1:05 - Jon Example\n  Later on.\n";
  check("layout, interleave and join", text === want, JSON.stringify(text));
}

// 2. An unnamed voice is "Unnamed voice N"; a `them` leftover on a split call
//    is "Unattributed", a different label.
{
  const text = formatTranscriptFile(
    {
      ...base,
      segments: [
        seg(0, "Named.", "Voice 1", "Alice Example"),
        seg(3, "Unnamed.", "Voice 2", null),
        seg(6, "No voice over half of this.", "them", null),
        seg(9, "Jon.", "me", "Jon Example"),
      ],
    },
    "UTC",
  );
  check("unnamed Voice 2 -> Unnamed voice 2", text.includes("0:03 - Unnamed voice 2\n"), text);
  check("leftover `them` on a split call -> Unattributed", text.includes("0:06 - Unattributed\n"), text);
  check("the two labels are different", !text.includes("0:06 - Unnamed voice") && !text.includes("0:03 - Unattributed"), text);
  check("named voice keeps its name", text.includes("0:00 - Alice Example\n"), text);
}

// 3. Two-party call whose guest was never named: one unnamed voice, numbered
//    so the host (if unnamed too) never shares its number.
{
  const text = formatTranscriptFile(
    { ...base, segments: [seg(0, "Hi.", "them", null), seg(2, "Hello.", "me", null)] },
    "UTC",
  );
  check("unnamed `them`, no voices -> Unnamed voice 1", text.includes("0:00 - Unnamed voice 1\n"), text);
  check("unnamed `me` -> a different number", text.includes("0:02 - Unnamed voice 2\n"), text);
}

// 3b. An unnamed `me` takes the host attendee's name when there is one.
{
  const segs = [seg(0, "Hi.", "me", null), seg(2, "Yo.", "Voice 1", "Alice Example")];
  const withHost = formatTranscriptFile({ ...base, hostName: "Jon Example", segments: segs }, "UTC");
  const noHost = formatTranscriptFile({ ...base, hostName: null, segments: segs }, "UTC");
  check("unnamed `me` + host attendee -> host name", withHost.includes("0:00 - Jon Example\n"), withHost);
  check("unnamed `me`, no host name -> Unnamed voice", noHost.includes("0:00 - Unnamed voice 2\n"), noHost);
}

// 4. A display name that is itself a track/voice label is not a name.
{
  const text = formatTranscriptFile(
    { ...base, segments: [seg(0, "x", "Voice 3", "Voice 3"), seg(2, "y", "them", "them"), seg(4, "z", "me", "Me")] },
    "UTC",
  );
  check("label-shaped display names are not used", badSpeakerLabels(text).length === 0, text);
}

// 5. The label search must find what it is looking for before its 0 hits count.
{
  const bad = "0:00 - them\n  x\n\n0:02 - Voice 2\n  y\n\n0:04 - me\n  z\n";
  check("search finds me/them/Voice N when present (3 hits)", badSpeakerLabels(bad).length === 3, JSON.stringify(badSpeakerLabels(bad)));
  const all = formatTranscriptFile(
    {
      ...base,
      segments: [
        seg(0, "a", "Voice 1", "Alice Example"),
        seg(2, "b", "Voice 2", null),
        seg(4, "c", "them", null),
        seg(6, "d", "me", "Jon Example"),
        seg(8, "e", null, null),
      ],
    },
    "UTC",
  );
  check("search finds 0 hits on a file with every label kind", badSpeakerLabels(all).length === 0, JSON.stringify(badSpeakerLabels(all)));
}

// 6. Timestamps.
check("0:07", formatTimestamp(7.9) === "0:07");
check("minutes have no leading zero (9:05)", formatTimestamp(545) === "9:05");
check("over an hour -> H:MM:SS", formatTimestamp(3725) === "1:02:05");

// 7. Title and file name.
check(
  "file name: date, title, en dash",
  suggestedFileName(base, "UTC") === "2026-03-02 Made-Up Sync – transcript.txt",
  suggestedFileName(base, "UTC"),
);
check(
  "auto title -> Untitled call, unsafe characters replaced",
  suggestedFileName({ title: "Clipwise capture — 2026-03-02T15-00-00Z", startedAt: when }, "UTC") === "2026-03-02 Untitled call – transcript.txt" &&
    suggestedFileName({ title: "A/B: plan?", startedAt: when }, "UTC") === "2026-03-02 A-B- plan- – transcript.txt",
);

// 8. Empty-text lines add no turn.
check("empty lines are dropped", buildTurns([seg(0, "  ", "me", "Jon Example"), seg(1, "ok", "me", "Jon Example")]).length === 1);

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
