// Check for "Someone else spoke into my mic" (SAA-224 11-06, SAA-260 11-07):
// the identity answer's mic_shared, from POST /captures through the speaker
// names, the transcript (the saved file and MCP get_transcript's page) and
// extraction. Real routes and the real database; the request's sign-in is a
// middleware that sets the access context the capture-token guard would, and
// the model is extract/stub-model.ts. Names are made up. The host is "Jon
// Example".
//
//   b1  a first answer marking the mic shared (one guest): me has no name,
//       them is the guest, the host's attendee row stays, and the stored
//       answer carries mic_shared
//   b2  its saved transcript file puts the me lines under "Unattributed",
//       never the host's name; the guest's lines keep the guest's name
//   b3  the same in MCP get_transcript's page
//   b4  extraction on it: pass 2's instructions carry the shared-mic guard,
//       and pass 1's carry the span-label one
//   b5  speakers on its moments: the model's "Jon Example" and "Jon" are
//       dropped; "Gina Guest" and "me" stay
//   b6  a marked call where another attendee is "Jon Other": "Jon" stays (it
//       may be theirs), "Jon Example" still goes
//   c0  control (unchanged): the same call unmarked names me the host, its
//       transcript puts the me lines under the host, and extraction has no
//       guard and keeps the model's speakers as given
//   c1  a correction that ticks the box: me loses its name, the host's
//       attendee row stays, one re_extract is queued, and the stored answer
//       carries mic_shared
//   c2  a correction that unticks it, sent without the field (the recorder
//       sends mic_shared only when ticked): me, unnamed before it, is the host
//       again, one re_extract is queued, and the stored answer no longer
//       carries mic_shared
//   c3  control (unchanged): an unanswered call's transcript keeps today's
//       fallback for me ("Unnamed voice N", not "Unattributed")
//
//   scripts/scratch-db.sh run check-mic-shared

import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { pool } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { runExtraction } from "../extract/extract.js";
import { makeStubModel, type StubSpan } from "../extract/stub-model.js";
import { errorHandler } from "../lib/http.js";
import { captureScopeRouter } from "../routes/capture-scope.js";
import { capturesPost } from "../routes/captures.js";
import { getTranscriptPage } from "../services/transcript.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string };
const seg = (track: "me" | "them", startSec: number, endSec: number, text: string): Seg =>
  ({ track, startMs: startSec * 1000, endMs: endSec * 1000, text });
const CALL: Seg[] = [seg("me", 0, 1.5, "opening line"), seg("them", 2, 4, "first reply"), seg("me", 5, 7, "second line"), seg("them", 8, 10, "second reply")];

const HOST = "Jon Example";
const GUEST = "Gina Guest";
const SHARER = "Jon Other";
// Guard phrases, as pass 2's and pass 1's instructions carry them.
const GUARD = "also spoke into their microphone";
const SPAN_GUARD = "also spoke into the recorder's microphone";

function payload(segments: Seg[], extra: Record<string, unknown> = {}): Record<string, unknown> & { captureId: string } {
  const id = randomUUID().toUpperCase();
  const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 10, gaps: [], note: "check" });
  return {
    captureId: id,
    startedAt: "2026-11-07T10:00:00.000Z",
    stem: `check-mic-shared-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: segments.reduce((n, x) => n + x.text.length, 0), countedFrom: "check-mic-shared" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...extra,
  };
}

const answer = (answeredAt: string, guests: string[], o: { micShared?: boolean; corrects?: string } = {}) => ({
  identity_version: 2,
  answered_at: answeredAt,
  self: { name: HOST, source: "account_display_name" },
  guests: guests.map((name) => ({ name })),
  scope: "work",
  ...(o.micShared ? { mic_shared: true } : {}),
  ...(o.corrects !== undefined ? { corrects: o.corrects } : {}),
});

async function main(): Promise<void> {
  await refuseUnlessScratch("check-mic-shared");
  process.env.ANTHROPIC_API_KEY = "stub-key";
  const fx = await makeAccount("check-mic-shared");
  const ctx = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: "check@clipwise.test", scope: ["clipwise:capture"] };
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = ctx as typeof req.access;
    next();
  });
  app.post("/captures", capturesPost);
  app.use(captureScopeRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const speaker = async (rec: string, label: string): Promise<string | null> =>
    (await pool.query(`select display_name from speakers where recording_id = $1 and label = $2`, [rec, label])).rows[0]?.display_name ?? null;
  const hostRow = async (rec: string): Promise<string | null> =>
    (await pool.query(`select name from attendees where recording_id = $1 and is_host`, [rec])).rows[0]?.name ?? null;
  const storedIdentity = async (rec: string): Promise<Record<string, unknown> | null> =>
    (await pool.query(`select metadata->'identity' as identity from recordings where id = $1`, [rec])).rows[0]?.identity ?? null;
  const reextracts = async (rec: string): Promise<number> =>
    (await pool.query(`select count(*)::int as n from jobs where recording_id = $1 and kind = 're_extract'`, [rec])).rows[0].n;
  const clearReextracts = async (rec: string): Promise<void> => {
    await pool.query(`delete from jobs where recording_id = $1 and kind = 're_extract'`, [rec]);
  };
  // Names in the saved transcript file ("M:SS - Name") and in the page ("[#i M:SS] Name: text").
  const fileNames = async (captureId: string): Promise<string[]> => {
    const res = await fetch(`${base}/captures/${captureId}/transcript`);
    const json = (await res.json()) as { text?: string };
    return [...new Set([...(json.text ?? "").matchAll(/^\d+:\d\d - (.+)$/gm)].map((m) => m[1]))].sort();
  };
  const pageNames = async (rec: string): Promise<string[]> => {
    const { page } = await getTranscriptPage(ctx as Parameters<typeof getTranscriptPage>[0], rec, {});
    return [...new Set([...JSON.stringify(page).matchAll(/\] ([^:\\]+): /g)].map((m) => m[1]))].sort();
  };
  // One extraction with the stub, every moment naming `speakers`; what pass 1
  // and pass 2 were sent, and the speakers stored on the promoted run.
  const extractWith = async (rec: string, speakers: string[]) => {
    const stub = makeStubModel({
      segmentCount: CALL.length,
      phrase: "check-mic-shared",
      pass2Moments: (span: StubSpan) => [{ kind: "discussion", title: `a point in ${span.label}`, summary: "a point", start_sec: span.startSec, end_sec: span.endSec, is_personnel_assessment: false, speakers }],
    });
    await runExtraction(rec, { client: stub.client });
    const body = (kind: string) => stub.bodies.filter((_, i) => stub.calls[i] === kind).join("\n");
    const stored = (await pool.query(
      `select m.metadata->'speakers' as speakers from moments m join recordings r on r.id = m.recording_id
        where m.recording_id = $1 and m.metadata->>'extraction_run' = r.metadata->>'current_extraction_run'`,
      [rec],
    )).rows.map((r) => JSON.stringify(r.speakers));
    return { pass1: body("pass1"), pass2: body("pass2"), stored };
  };
  const SAID = [HOST, "Jon", GUEST, "me"];

  try {
    // b1-b5: a first answer marking the mic shared.
    const p1 = payload(CALL, { identity: answer("2026-11-07T10:20:00.000Z", [GUEST], { micShared: true }) });
    const r1 = await post(p1);
    const rec1 = String(r1.json.recordingId);
    const id1 = await storedIdentity(rec1);
    check(
      "b1: a first answer marking the mic shared: me has no name, them is the guest, the host's attendee row stays, and the stored answer carries mic_shared",
      r1.status === 201 && (await speaker(rec1, "me")) === null && (await speaker(rec1, "them")) === GUEST && (await hostRow(rec1)) === HOST && id1?.mic_shared === true,
      `${r1.status}; me ${JSON.stringify(await speaker(rec1, "me"))}, them ${JSON.stringify(await speaker(rec1, "them"))}, host row ${JSON.stringify(await hostRow(rec1))}, stored mic_shared ${JSON.stringify(id1?.mic_shared)}`,
    );
    const f1 = await fileNames(p1.captureId);
    check(
      "b2: its saved transcript file puts the me lines under Unattributed, never the host's name; the guest's lines keep the guest's name",
      JSON.stringify(f1) === JSON.stringify([GUEST, "Unattributed"].sort()),
      JSON.stringify(f1),
    );
    const g1 = await pageNames(rec1);
    check("b3: the same in MCP get_transcript's page", JSON.stringify(g1) === JSON.stringify([GUEST, "Unattributed"].sort()), JSON.stringify(g1));
    const e1 = await extractWith(rec1, SAID);
    check(
      "b4: extraction on it: pass 2's instructions carry the shared-mic guard, and pass 1's the span-label one",
      e1.pass2.includes(GUARD) && e1.pass1.includes(SPAN_GUARD),
      `pass 2 guard ${e1.pass2.includes(GUARD)}, pass 1 guard ${e1.pass1.includes(SPAN_GUARD)}`,
    );
    check(
      `b5: speakers on its moments: the model's "${HOST}" and "Jon" are dropped; "${GUEST}" and "me" stay`,
      e1.stored.length > 0 && e1.stored.every((s) => s === JSON.stringify([GUEST, "me"])),
      JSON.stringify(e1.stored),
    );

    // b6: another attendee shares the host's first name.
    // One guest, so `them` is named and the call resolved: on an unresolved call
    // the existing filter keeps only "me"/"them" and no name reaches speakers.
    const p6 = payload(CALL, { identity: answer("2026-11-07T10:21:00.000Z", [SHARER], { micShared: true }) });
    const rec6 = String((await post(p6)).json.recordingId);
    const e6 = await extractWith(rec6, [HOST, "Jon", SHARER, "me"]);
    check(
      `b6: a marked call where another attendee is "${SHARER}": "Jon" stays (it may be theirs), "${HOST}" still goes`,
      e6.stored.length > 0 && e6.stored.every((s) => s === JSON.stringify(["Jon", SHARER, "me"])),
      JSON.stringify(e6.stored),
    );

    // c0: the same call unmarked; then c1, c2 correct it.
    const A = "2026-11-07T10:30:00.000Z";
    const B = "2026-11-07T10:40:00.000Z";
    const C = "2026-11-07T10:50:00.000Z";
    const p3 = payload(CALL, { identity: answer(A, [GUEST]) });
    const r3 = await post(p3);
    const rec3 = String(r3.json.recordingId);
    const f3 = await fileNames(p3.captureId);
    const e3 = await extractWith(rec3, SAID);
    check(
      "c0: control (unchanged): the same call unmarked names me the host, its transcript puts the me lines under the host, and extraction has no guard and keeps the model's speakers",
      r3.status === 201 && (await speaker(rec3, "me")) === HOST && JSON.stringify(f3) === JSON.stringify([GUEST, HOST].sort()) &&
        !e3.pass2.includes(GUARD) && !e3.pass1.includes(SPAN_GUARD) && e3.stored.length > 0 && e3.stored.every((s) => s === JSON.stringify(SAID)),
      `${r3.status}; me ${JSON.stringify(await speaker(rec3, "me"))}; file ${JSON.stringify(f3)}; guard ${e3.pass2.includes(GUARD)}/${e3.pass1.includes(SPAN_GUARD)}; stored ${JSON.stringify(e3.stored)}`,
    );

    await clearReextracts(rec3);
    const r4 = await post({ ...p3, identity: answer(B, [GUEST], { micShared: true, corrects: A }) });
    const id4 = await storedIdentity(rec3);
    const n4 = await reextracts(rec3);
    const me4 = await speaker(rec3, "me");
    check(
      "c1: a correction that ticks the box: me loses its name, the host's attendee row stays, one re_extract is queued, and the stored answer carries mic_shared",
      r4.status === 200 && r4.json.identityApplied === true && me4 === null && (await hostRow(rec3)) === HOST && n4 === 1 && id4?.mic_shared === true,
      `${r4.status} applied ${JSON.stringify(r4.json.identityApplied)}; me ${JSON.stringify(me4)}; host row ${JSON.stringify(await hostRow(rec3))}; re_extract ${n4}; stored mic_shared ${JSON.stringify(id4?.mic_shared)}`,
    );

    await clearReextracts(rec3);
    const r5 = await post({ ...p3, identity: answer(C, [GUEST], { corrects: B }) });
    const id5 = await storedIdentity(rec3);
    const n5 = await reextracts(rec3);
    const me5 = await speaker(rec3, "me");
    check(
      "c2: a correction that unticks it, sent without the field: me, unnamed before it, is the host again, one re_extract is queued, and the stored answer no longer carries mic_shared",
      r5.status === 200 && me4 === null && me5 === HOST && n5 === 1 && id5 !== null && !("mic_shared" in id5) && id5.answered_at === C,
      `${r5.status}; me before ${JSON.stringify(me4)}, after ${JSON.stringify(me5)}; re_extract ${n5}; stored keys ${JSON.stringify(id5 ? Object.keys(id5) : null)}`,
    );

    // c3: no answer at all.
    const p7 = payload(CALL);
    await post(p7);
    const f7 = await fileNames(p7.captureId);
    check(
      "c3: control (unchanged): an unanswered call's transcript keeps today's fallback for me (Unnamed voice N, not Unattributed)",
      !f7.includes("Unattributed") && f7.length === 2 && f7.every((n) => /^Unnamed voice \d+$/.test(n)),
      JSON.stringify(f7),
    );
  } finally {
    server.close();
    await dropAccount(fx);
    await endPool();
  }
  console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
