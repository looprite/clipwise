// Regression check for assignVoice's majority rule (SAA-199, 2026-09-29),
// replacing "any positive overlap wins" and the nearest-distance fallback.
// Same plain-script/exit-code shape as check-match-calendar.ts.
//
// Usage:
//   tsx src/pipeline/check-assign-voice.ts

import { assignVoice, type DiarizeSegment } from "./diarize.js";

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

function main(): number {
  let failures = 0;
  for (const c of CASES) {
    const got = assignVoice(c.segStart, c.segEnd, c.diarized);
    const ok = got === c.expect;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${c.name}: expected ${c.expect}, got ${got}\n`);
    if (!ok) failures += 1;
  }
  process.stdout.write(`\n${CASES.length - failures}/${CASES.length} passed\n`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("check-assign-voice.ts")) {
  process.exit(main());
}
