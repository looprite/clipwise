// Regression check for assignVoice's majority rule (SAA-199, 2026-09-29),
// replacing "any positive overlap wins" and the nearest-distance fallback.
// Same plain-script/exit-code shape as check-match-calendar.ts.
//
// Also (SAA-227 decisions 1 and 2):
//   - the Mac's copy of the rule (recorder/app/identity-answer.js) gives the same
//     answer as this one on every case;
//   - with --capture <dir> <stem>, the naming data for a group capture's files is
//     built with no database: run with DATABASE_URL unset, which the database
//     module refuses to load under, so nothing here can have read one. The inputs
//     are linked into a temporary folder and the output written there, never into
//     <dir>. It has a clip file for every clip range and lines for every voice, no
//     speakerId, and the same voices and lines as the voices-<stem>.json already
//     in <dir>. Only counts are printed, never a line of the call.
//
// Usage:
//   tsx src/pipeline/check-assign-voice.ts
//   env -u DATABASE_URL tsx src/pipeline/check-assign-voice.ts --capture <dir> <stem>

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assignVoice, generateVoiceNamingData, namingDataPathFor, type DiarizeSegment, type NamingData } from "./voice-clips.js";

const macAssignVoice = (createRequire(import.meta.url)(resolve(import.meta.dirname, "..", "..", "..", "recorder", "app", "identity-answer.js")) as {
  assignVoice: (start: number, end: number, diarized: DiarizeSegment[]) => number | null;
}).assignVoice;

type Case = {
  name: string;
  segStart: number;
  segEnd: number;
  diarized: DiarizeSegment[];
  expect: number | null;
};

const CASES: Case[] = [
  {
    name: "one voice covers the whole segment — assigned",
    segStart: 0,
    segEnd: 10,
    diarized: [{ start: 0, end: 10, voiceIndex: 1 }],
    expect: 1,
  },
  {
    name: "sliver overlap only (10%), no other coverage — unnamed, not assigned by proximity",
    segStart: 173.79,
    segEnd: 177.22,
    // The real 09-28 sync shape: one turn ending 0.34s into the segment,
    // nothing else overlapping it at all until well after it ends.
    diarized: [
      { start: 165.6, end: 174.13, voiceIndex: 1 },
      { start: 184.87, end: 186.3, voiceIndex: 1 },
    ],
    expect: null,
  },
  {
    name: "no diarized coverage anywhere — unnamed, no nearest-voice fallback",
    segStart: 100,
    segEnd: 110,
    diarized: [
      { start: 50, end: 60, voiceIndex: 1 },
      { start: 200, end: 210, voiceIndex: 2 },
    ],
    expect: null,
  },
  {
    name: "best overlap is an excluded voice — unnamed, not counted toward any real voice",
    segStart: 0,
    segEnd: 10,
    diarized: [{ start: 0, end: 10, voiceIndex: null }],
    expect: null,
  },
  {
    name: "two real voices split the segment ~evenly — neither reaches a majority, unnamed",
    segStart: 0,
    segEnd: 10,
    diarized: [
      { start: 0, end: 5, voiceIndex: 2 },
      { start: 5, end: 10, voiceIndex: 3 },
    ],
    expect: null,
  },
  {
    name: "several short turns of the SAME voice sum to a majority — assigned",
    segStart: 0,
    segEnd: 10,
    // Neither turn of voice 1 alone reaches a majority (3s each, 30%), but
    // summed (6s, 60%) they do — the whole point of summing per voice
    // instead of taking one turn's overlap.
    diarized: [
      { start: 0, end: 3, voiceIndex: 1 },
      { start: 4, end: 7, voiceIndex: 1 }, // 6s of voice 1 total
      { start: 8, end: 9, voiceIndex: 2 }, // 1s of voice 2
    ],
    expect: 1,
  },
  {
    name: "exactly half covered by one voice — not a majority, unnamed",
    segStart: 0,
    segEnd: 10,
    diarized: [{ start: 0, end: 5, voiceIndex: 1 }],
    expect: null,
  },
];

async function namingDataFromFiles(dir: string, stem: string): Promise<Array<[string, boolean, string]>> {
  const results: Array<[string, boolean, string]> = [];
  const sidecar = JSON.parse(readFileSync(join(dir, `diarize-${stem}.json`), "utf8")) as {
    voices: Array<{ voiceIndex: number; clipRanges: Array<{ start: number; end: number }> }>;
    segments: DiarizeSegment[];
  };
  const tmp = mkdtempSync(join(tmpdir(), "check-assign-voice-"));
  try {
    for (const f of [`system-${stem}.f32le.pcm`, `transcript-${stem}.json`, `manifest-${stem}.json`]) {
      symlinkSync(join(dir, f), join(tmp, f));
    }
    await generateVoiceNamingData(tmp, stem, sidecar);
    const doc = JSON.parse(readFileSync(namingDataPathFor(tmp, stem), "utf8")) as NamingData;
    const want = sidecar.voices.map((v) => v.voiceIndex);
    const got = doc.voices.map((v) => v.voiceIndex);
    results.push(["naming data: one entry per voice in the sidecar", JSON.stringify(got) === JSON.stringify(want), `sidecar ${want.join(",")} naming ${got.join(",")}`]);
    const clipCounts = doc.voices.map((v, i) => {
      const ranges = sidecar.voices[i]?.clipRanges.length ?? -1;
      const written = v.clipPaths.filter((p) => p.startsWith(tmp) && existsSync(p) && statSync(p).size > 44).length;
      return `${v.voiceIndex}:${written}/${ranges}`;
    });
    results.push([
      "naming data: a clip file with audio in it for every clip range, in the temporary folder",
      doc.voices.every((v, i) => v.clipPaths.length === sidecar.voices[i]?.clipRanges.length && v.clipPaths.every((p) => p.startsWith(tmp) && existsSync(p) && statSync(p).size > 44)),
      clipCounts.join(" "),
    ]);
    results.push(["naming data: at least one line for every voice", doc.voices.every((v) => v.lines.length > 0), doc.voices.map((v) => `${v.voiceIndex}:${v.lines.length}`).join(" ")]);
    results.push(["naming data: no speakerId", !JSON.stringify(doc).includes("speakerId"), ""]);
    const before = JSON.parse(readFileSync(namingDataPathFor(dir, stem), "utf8")) as NamingData;
    const texts = (d: NamingData) => d.voices.map((v) => [v.voiceIndex, v.lines.map((l) => l.text).sort()]);
    const same = before.voices.map((v) => {
      const mine = doc.voices.find((x) => x.voiceIndex === v.voiceIndex);
      return `${v.voiceIndex}:${mine && JSON.stringify(mine.lines.map((l) => l.text).sort()) === JSON.stringify(v.lines.map((l) => l.text).sort()) ? "same" : "differs"}`;
    });
    results.push(["naming data: the same voices and lines as the voices file the database path wrote", JSON.stringify(texts(doc)) === JSON.stringify(texts(before)), same.join(" ")]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

async function main(): Promise<number> {
  let failures = 0;
  for (const c of CASES) {
    const got = assignVoice(c.segStart, c.segEnd, c.diarized);
    const mac = macAssignVoice(c.segStart, c.segEnd, c.diarized);
    const ok = got === c.expect && mac === c.expect;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${c.name}: expected ${c.expect}, got ${got}, the Mac's copy ${mac}\n`);
    if (!ok) failures += 1;
  }
  let total = CASES.length;
  const at = process.argv.indexOf("--capture");
  if (at !== -1) {
    const [dir, stem] = process.argv.slice(at + 1, at + 3);
    if (!dir || !stem) {
      process.stdout.write("usage: --capture <dir> <stem>\n");
      return 2;
    }
    if (process.env.DATABASE_URL !== undefined) {
      process.stdout.write("refusing: --capture runs with DATABASE_URL unset, so that no database can be read\n");
      return 2;
    }
    for (const [name, ok, detail] of await namingDataFromFiles(resolve(dir), stem)) {
      process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}\n`);
      total += 1;
      if (!ok) failures += 1;
    }
  }
  process.stdout.write(`\n${total - failures}/${total} passed\n`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("check-assign-voice.ts")) {
  main().then((code) => process.exit(code));
}
