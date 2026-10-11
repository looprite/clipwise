// Check that extraction logs no words of a call (SAA-227 decision 3).
//
// The real extraction path (runExtraction: both passes, collapse, the retry and
// failure branches) runs against a database, with the real Anthropic SDK on a
// stub fetch that plants a known phrase in every span label and moment title, and
// in an attendee's name. Every console method and every direct write to stdout or
// stderr is captured for the whole run (the check's own lines are kept out). The
// phrase must be in no line, and in no error message that leaves runExtraction.
//
// Positive control, inside the same run: the phrase is in the stub's replies and
// in the moments written to the database, so it did reach the code.
//
// Scenarios, each reaching a different log line:
//   A. a normal run: one moment out of its span's range (warns with its title),
//      one span with no moments (logs its label)
//   B. a span whose first reply has the wrong shape (warns with the reply)
//   C. a span whose every reply has the wrong shape (throws)
//   D. the identity and voice-naming describe lines (describeRows,
//      describeMapping, describeVoiceNaming), with planted names
//
//   scripts/scratch-db.sh run check-log-content

import { inArray, sql } from "drizzle-orm";
import { inspect } from "node:util";
import { db, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "./fixtures-for-checks.js";
import { runExtraction } from "./extract.js";
import { applyIdentity, applySpeakerNames, describeMapping, describeRows, type IdentityAnswer } from "../ingest/identity.js";
import { applyVoiceNames, describeVoiceNaming, type VoiceNamesAnswer } from "../ingest/voice-names.js";
import { defaultPass2Moments, makeStubModel } from "./stub-model.js";

const PHRASE = "PURPLE-ELEPHANT-4417";
// The check's own lines go out through the original stdout.write, taken before
// anything is patched, so they are never in the scan.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const say = (s: string): void => {
  realStdoutWrite(`${s}\n`);
};
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  say(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

// Everything the code prints, captured: console.log, info, warn, error and
// debug, and direct writes to process.stdout and process.stderr.
function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const take = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "));
  };
  const takeWrite = ((chunk: unknown): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  console.log = take;
  console.info = take;
  console.warn = take;
  console.error = take;
  console.debug = take;
  process.stdout.write = takeWrite;
  process.stderr.write = takeWrite;
  return {
    lines,
    stop: () => {
      Object.assign(console, savedConsole);
      process.stdout.write = savedOut;
      process.stderr.write = savedErr;
    },
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-log-content");
  const fx = await makeAccount("check-log-content");
  try {
    const segments = 6;

    // A. normal run with an out-of-range moment and an empty span.
    const a = await makeRecording(fx, { segments, attendeeName: `${PHRASE} Attendee` });
    const stubA = makeStubModel({
      segmentCount: segments,
      phrase: PHRASE,
      pass2Moments: (span, _attempt) => {
        if (span.index === 1) return [];
        const ms = defaultPass2Moments(span, PHRASE) as { start_sec: number; end_sec: number }[];
        ms[0].end_sec = span.endSec + 500;
        return ms;
      },
    });
    let logs = captureLogs();
    let resultA: Awaited<ReturnType<typeof runExtraction>> | null = null;
    try {
      resultA = await runExtraction(a, { client: stubA.client });
    } finally {
      logs.stop();
    }
    const linesA = logs.lines;
    const rowsA = await db.select({ title: schema.moments.title }).from(schema.moments).where(sql`recording_id = ${a}`);
    check("A positive control: the planted phrase reached the code (stub replied with it, moments in the database carry it)", rowsA.length > 0 && rowsA.every((r) => r.title?.includes(PHRASE)), `rows=${rowsA.length}`);
    check("A positive control: the run exercised the out-of-range and the empty-span branches", resultA !== null && resultA.outOfRangeCount > 0 && resultA.spansYieldingZeroMoments.length > 0, JSON.stringify({ oor: resultA?.outOfRangeCount, zero: resultA?.spansYieldingZeroMoments.length }));
    check("A positive control: the capture saw log lines", linesA.length > 10, `lines=${linesA.length}`);
    check("A no log line holds the phrase", !linesA.some((l) => l.includes(PHRASE)), linesA.filter((l) => l.includes(PHRASE)).join("\n     "));

    // B. a bad shape once, then good.
    const b = await makeRecording(fx, { segments });
    const stubB = makeStubModel({
      segmentCount: segments,
      phrase: PHRASE,
      pass2Moments: (span, attempt) => (span.index === 0 && attempt === 1 ? { oops: `${PHRASE} not a list` } : defaultPass2Moments(span, PHRASE)),
    });
    logs = captureLogs();
    try {
      await runExtraction(b, { client: stubB.client });
    } finally {
      logs.stop();
    }
    check("B positive control: the bad-shape branch ran (a retry warning was logged)", logs.lines.some((l) => /attempt 1\/3/.test(l)), logs.lines.join(" | ").slice(0, 300));
    check("B no log line holds the phrase", !logs.lines.some((l) => l.includes(PHRASE)), logs.lines.filter((l) => l.includes(PHRASE)).join("\n     "));

    // C. every reply the wrong shape: it throws; neither the log nor the error may hold the phrase.
    const c = await makeRecording(fx, { segments });
    const stubC = makeStubModel({
      segmentCount: segments,
      phrase: PHRASE,
      pass2Moments: () => ({ oops: `${PHRASE} not a list` }),
    });
    logs = captureLogs();
    let thrown: unknown = null;
    try {
      await runExtraction(c, { client: stubC.client });
    } catch (err) {
      thrown = err;
    } finally {
      logs.stop();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    check("C positive control: it threw", thrown !== null, "no error");
    check("C no log line holds the phrase", !logs.lines.some((l) => l.includes(PHRASE)), logs.lines.filter((l) => l.includes(PHRASE)).join("\n     "));
    check("C the thrown error message holds no phrase", !message.includes(PHRASE), message);

    // D. the identity and voice-naming log lines (SAA-227 decision 6): the real
    // apply functions write planted names, then each describe function's output
    // is logged the way its callers log it. A second pass makes the skip branches
    // run, whose reasons quote the name already there.
    // Voice naming gets its own recording: a one-guest identity answer merges
    // Voice rows back into `them`, which would leave nothing to name.
    const d = await makeRecording(fx, { segments });
    const e = await makeRecording(fx, { segments });
    await db.insert(schema.speakers).values([
      { recordingId: e, label: "Voice 1" },
      { recordingId: e, label: "Voice 2" },
    ]);
    const answer: IdentityAnswer = { self: { name: `${PHRASE} Host` }, guests: [{ name: `${PHRASE} Guest` }] };
    const voices = (n: number): VoiceNamesAnswer => ({
      answered_at: `2026-10-11T00:00:0${n}Z`,
      voices: [{ voiceIndex: 1, name: `${PHRASE} Voice ${n}` }, { voiceIndex: 2, name: null }, { voiceIndex: 3, name: `${PHRASE} Nobody` }],
    });
    const inputs: string[] = [];
    logs = captureLogs();
    try {
      for (const n of [1, 2]) {
        const rows = await applyIdentity(db, d, answer);
        const mapping = await applySpeakerNames(db, d, answer);
        const naming = await applyVoiceNames(db, e, voices(n));
        inputs.push(JSON.stringify(n === 1 ? rows.inserted : rows.skipped), JSON.stringify(mapping), JSON.stringify(naming));
        console.log(`apply-identity: inserted=${describeRows(rows.inserted)} already_present=${describeRows(rows.skipped)}`);
        console.log(`apply-identity: speaker names ${describeMapping(mapping)}`);
        console.log(`apply-voice-names: ${describeVoiceNaming(naming)}`);
      }
    } finally {
      logs.stop();
    }
    const describeLines = logs.lines.filter((l) => /^apply-(identity|voice-names): /.test(l));
    check(
      "D positive control: the planted names reached every describe input (inserted, already present, applied, skipped)",
      inputs.length === 6 && inputs.every((s) => s.includes(PHRASE)) && /already named/.test(inputs[4]) && /already named/.test(inputs[5]),
      inputs.map((s) => (s.includes(PHRASE) ? "has" : "lacks")).join(" "),
    );
    check("D positive control: six describe lines were logged", describeLines.length === 6, `lines=${describeLines.length}`);
    const dHits = logs.lines.filter((l) => l.includes(PHRASE));
    say(`     D lines holding the phrase: ${dHits.length}`);
    check("D no log line holds the phrase", dHits.length === 0, dHits.join("\n     "));

    await db.delete(schema.moments).where(inArray(schema.moments.recordingId, [a, b, c]));
  } finally {
    await dropAccount(fx);
    await endPool();
  }
  say(failures === 0 ? "\ncheck-log-content: all passed" : `\ncheck-log-content: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  say(`check-log-content: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
