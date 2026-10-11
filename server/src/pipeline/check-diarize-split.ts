// Check for the diarize split on the server (SAA-227 decision 4): POST /captures
// writes the Voice N rows inside the capture's transaction, before the extract job
// is queued, with pipeline/diarize.ts's gates. Real route and real database; the
// request's sign-in is a middleware that sets the access context the capture-token
// guard would (who may call is check-access's business), and the model is
// extract/stub-model.ts.
//
// The Mac's half is played here as the recorder will do it: assignVoice (the
// majority rule) over a diarize-shaped list of turns gives each `them` segment its
// voice index. The expected speaker of every segment is written out by hand.
//
//   3   three voices: Voice 1..3 rows, each segment on the voice that covers most
//       of it, `them` deleted (nothing stayed on it)
//   3k  three voices with one segment no voice covers most of: it stays on `them`,
//       which is kept
//   1   one voice: nothing split, the single `them` row stands
//   g   three voices, but the identity answer names the one guest: nothing split,
//       `them` carries the name
//   j   the queued extract job sees the split: one job, queued, in the same commit
//       as the Voice rows; a run on it is built on the split roster
//
//   scripts/scratch-db.sh run check-diarize-split

import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { runExtraction, speakerFingerprintHash } from "../extract/extract.js";
import { makeStubModel } from "../extract/stub-model.js";
import { errorHandler } from "../lib/http.js";
import { capturesPost } from "../routes/captures.js";
import { assignVoice, type DiarizeSegment } from "./diarize.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string; voiceIndex?: number };
const seg = (track: "me" | "them", startSec: number, endSec: number, text: string): Seg => ({ track, startMs: startSec * 1000, endMs: endSec * 1000, text });

// Diarized turns, in seconds, as diarize's sidecar has them.
const TURNS: DiarizeSegment[] = [
  { start: 1.8, end: 4.2, voiceIndex: 1 },
  { start: 4.9, end: 7.1, voiceIndex: 2 },
  { start: 7.9, end: 10.1, voiceIndex: 3 },
  { start: 10.9, end: 13.1, voiceIndex: 3 },
  { start: 13.9, end: 16.1, voiceIndex: 1 },
  { start: 19.7, end: 20.0, voiceIndex: 2 },
  { start: 21.0, end: 22.2, voiceIndex: 1 },
  { start: 22.2, end: 23.0, voiceIndex: 3 },
];
const VOICES = [
  { voiceIndex: 1, totalSeconds: 5.8 },
  { voiceIndex: 2, totalSeconds: 2.5 },
  { voiceIndex: 3, totalSeconds: 5.2 },
];
// The segments, and the speaker each should end on, by hand.
const ALL_COVERED: Array<[Seg, string]> = [
  [seg("me", 0, 1.5, "opening"), "me"],
  [seg("them", 2, 4, "first"), "Voice 1"],
  [seg("them", 5, 7, "second"), "Voice 2"],
  [seg("them", 8, 10, "third"), "Voice 3"],
  [seg("them", 11, 13, "fourth"), "Voice 3"],
  [seg("them", 14, 16, "fifth"), "Voice 1"],
  // 60% Voice 1, 40% Voice 3: the majority wins.
  [seg("them", 21, 23, "shared"), "Voice 1"],
];
// 10% Voice 2 only: no majority, so it stays on `them`.
const SLIVER: [Seg, string] = [seg("them", 17, 20, "sliver"), "them"];

// The Mac's half: assignVoice gives each `them` segment its voice index.
function withVoiceIndexes(segs: Seg[]): Seg[] {
  return segs.map((s) => {
    if (s.track !== "them") return s;
    const v = assignVoice(s.startMs / 1000, s.endMs / 1000, TURNS);
    return v === null ? s : { ...s, voiceIndex: v };
  });
}

function payload(segments: Seg[], extra: Record<string, unknown> = {}): Record<string, unknown> & { captureId: string } {
  const id = randomUUID().toUpperCase();
  const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 23, gaps: [], note: "check" });
  return {
    captureId: id,
    startedAt: "2026-10-11T10:00:00.000Z",
    stem: `check-diarize-split-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: segments.reduce((n, x) => n + x.text.length, 0), countedFrom: "check-diarize-split" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...extra,
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-diarize-split");
  process.env.ANTHROPIC_API_KEY = "stub-key";
  const fx = await makeAccount("check-diarize-split");
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: "check@clipwise.test", scope: ["clipwise:capture"] };
    next();
  });
  app.post("/captures", capturesPost);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  // Each segment's speaker label, in segment order, and the recording's speaker rows.
  const segmentSpeakers = async (recordingId: string): Promise<string[]> =>
    (await pool.query(
      `select coalesce(sp.label, '(none)') as label from segments s left join speakers sp on sp.id = s.speaker_id where s.recording_id = $1 order by s.order_index`,
      [recordingId],
    )).rows.map((r) => r.label);
  const speakerRows = async (recordingId: string): Promise<Array<{ label: string; name: string | null }>> =>
    (await pool.query(`select label, display_name as name from speakers where recording_id = $1 order by label`, [recordingId])).rows;

  try {
    // 3. three voices, every segment covered by a majority.
    const p3 = payload(withVoiceIndexes(ALL_COVERED.map(([s]) => s)), { voices: VOICES });
    const r3 = await post(p3);
    const rec3 = String(r3.json.recordingId);
    const want3 = ALL_COVERED.map(([, l]) => l);
    const got3 = await segmentSpeakers(rec3);
    const rows3 = (await speakerRows(rec3)).map((r) => r.label);
    check("3: 201", r3.status === 201, `${r3.status} ${JSON.stringify(r3.json)}`);
    check("3: each segment is on the voice the majority rule gives (written out by hand)", JSON.stringify(got3) === JSON.stringify(want3), `want ${want3.join(",")} got ${got3.join(",")}`);
    check("3: speaker rows are me and Voice 1..3; `them` is gone", JSON.stringify(rows3.slice().sort()) === JSON.stringify(["Voice 1", "Voice 2", "Voice 3", "me"].sort()), rows3.join(","));

    // 3k. the same, plus a segment no voice covers most of.
    const segs3k = [...ALL_COVERED, SLIVER];
    const p3k = payload(withVoiceIndexes(segs3k.map(([s]) => s)), { voices: VOICES });
    const r3k = await post(p3k);
    const rec3k = String(r3k.json.recordingId);
    const got3k = await segmentSpeakers(rec3k);
    const want3k = segs3k.map(([, l]) => l);
    const rows3k = (await speakerRows(rec3k)).map((r) => r.label);
    check("3k: 201", r3k.status === 201, `${r3k.status} ${JSON.stringify(r3k.json)}`);
    check("3k: the uncovered segment stays on `them`, the rest on their voices", JSON.stringify(got3k) === JSON.stringify(want3k), `want ${want3k.join(",")} got ${got3k.join(",")}`);
    check("3k: `them` is kept beside Voice 1..3", JSON.stringify(rows3k.slice().sort()) === JSON.stringify(["Voice 1", "Voice 2", "Voice 3", "me", "them"].sort()), rows3k.join(","));

    // 1. one voice: unchanged.
    const one = ALL_COVERED.map(([s]) => (s.track === "them" ? { ...s, voiceIndex: 1 } : s));
    const r1 = await post(payload(one, { voices: [{ voiceIndex: 1, totalSeconds: 13.5 }] }));
    const rec1 = String(r1.json.recordingId);
    const got1 = await segmentSpeakers(rec1);
    check("1: 201", r1.status === 201, `${r1.status} ${JSON.stringify(r1.json)}`);
    check("1: one voice splits nothing: me and them only, every them segment on them", JSON.stringify((await speakerRows(rec1)).map((r) => r.label)) === JSON.stringify(["me", "them"]) && got1.filter((l) => l === "them").length === 6, got1.join(","));

    // g. three voices, but the answer names exactly one guest.
    const identity = { answered_at: "2026-10-11T10:30:00Z", self: { name: "Check Host" }, guests: [{ name: "Check Guest" }], scope: "work" };
    const rg = await post(payload(withVoiceIndexes(ALL_COVERED.map(([s]) => s)), { voices: VOICES, identity }));
    const recg = String(rg.json.recordingId);
    const rowsg = await speakerRows(recg);
    const gotg = await segmentSpeakers(recg);
    check("g: 201", rg.status === 201, `${rg.status} ${JSON.stringify(rg.json)}`);
    check(
      "g: one guest named outranks the voice count: no Voice rows, `them` named, every them segment on it",
      rowsg.length === 2 && rowsg.some((r) => r.label === "them" && r.name === "Check Guest") && gotg.filter((l) => l === "them").length === 6,
      JSON.stringify(rowsg.map((r) => r.label)) + " " + gotg.join(","),
    );

    // j. the queued job sees the split.
    const both = (await pool.query(
      `select (select count(*)::int from jobs where recording_id = $1 and kind = 'extract' and state = 'queued') as jobs,
              (select count(*)::int from speakers where recording_id = $1 and label ~ '^Voice [0-9]+$') as voices,
              (select count(*)::int from speakers where recording_id = $1 and label = 'them') as them`,
      [rec3],
    )).rows[0];
    check("j: one queued extract job, committed with the three Voice rows and no `them`", both.jobs === 1 && both.voices === 3 && both.them === 0, JSON.stringify(both));
    const stub = makeStubModel({ segmentCount: ALL_COVERED.length, phrase: "check-diarize-split" });
    await runExtraction(rec3, { client: stub.client });
    const [rec] = await db.select({ metadata: schema.recordings.metadata }).from(schema.recordings).where(eq(schema.recordings.id, rec3));
    const fp = (rec?.metadata as { extraction_speaker_fingerprint?: string } | null)?.extraction_speaker_fingerprint;
    check(
      "j: a run on that recording is built on the split roster (its stored speaker fingerprint is the roster's with Voice 1..3)",
      typeof fp === "string" && fp === (await speakerFingerprintHash(rec3)) && (await speakerRows(rec3)).filter((r) => /^Voice /.test(r.label)).length === 3,
      `fp=${fp ? "set" : "missing"}`,
    );
    await db.delete(schema.jobs).where(eq(schema.jobs.accountId, fx.accountId));
    await db.execute(sql`delete from moments where recording_id = ${rec3}`);
  } finally {
    server.close();
    await dropAccount(fx);
    await endPool();
  }
  console.log(failures === 0 ? "\ncheck-diarize-split: all passed" : `\ncheck-diarize-split: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`check-diarize-split: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
