// Check for correcting a saved identity answer (SAA-258): POST /captures with an
// identity answer carrying `corrects`. Real route and real database; the
// request's sign-in is a middleware that sets the access context the
// capture-token guard would, and the model is extract/stub-model.ts. Names are
// made up.
//
//   m   the plan's case: a one-guest call answered "Wiliam Example", corrected
//       to "William Example" and to personal. Attendees, `them` and scope are
//       replaced, one re_extract is queued, and the attendee search finds the
//       call by the new name and not the old (it found it by the old before)
//   r   the same correction sent again (a lost reply): 200, applied once, no 409
//   u   control: a correction that changes nothing queues no re_extract
//   s   control: a correction of an answer the recording no longer holds gets
//       409 identity_correction_stale, and nothing is written
//   o   two corrections made offline: the second carries the first's
//       `corrects` forward (the stored answer's), and applies. Against it, the
//       second carrying the first correction's own answered_at, which the
//       server never saw, gets 409
//   n   a correction of a recording with no stored answer applies as its
//       first answer
//   v   a group call with named voices: a correction that removes a guest
//       unnames that guest's voice and keeps the others' names, including one
//       whose name the answer sends with stray spaces
//
//   scripts/scratch-db.sh run check-identity-correction

import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { pool } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { runExtraction } from "../extract/extract.js";
import { makeStubModel } from "../extract/stub-model.js";
import { errorHandler } from "../lib/http.js";
import { capturesPost } from "../routes/captures.js";
import { searchMoments } from "../services/search-moments.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string; voiceIndex?: number };
const seg = (track: "me" | "them", startSec: number, endSec: number, text: string, voiceIndex?: number): Seg =>
  ({ track, startMs: startSec * 1000, endMs: endSec * 1000, text, ...(voiceIndex ? { voiceIndex } : {}) });

const ONE_TO_ONE: Seg[] = [seg("me", 0, 1.5, "opening"), seg("them", 2, 4, "first"), seg("me", 5, 7, "second"), seg("them", 8, 10, "third")];
// Three voices on `them`, as check-diarize-split has them.
const GROUP: Seg[] = [
  seg("me", 0, 1.5, "opening"),
  seg("them", 2, 4, "first", 1),
  seg("them", 5, 7, "second", 2),
  seg("them", 8, 10, "third", 3),
  seg("them", 11, 13, "fourth", 3),
  seg("them", 14, 16, "fifth", 1),
];
const VOICES = [
  { voiceIndex: 1, totalSeconds: 5.8 },
  { voiceIndex: 2, totalSeconds: 2.5 },
  { voiceIndex: 3, totalSeconds: 5.2 },
];

function payload(segments: Seg[], extra: Record<string, unknown> = {}): Record<string, unknown> & { captureId: string } {
  const id = randomUUID().toUpperCase();
  const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 16, gaps: [], note: "check" });
  return {
    captureId: id,
    startedAt: "2026-10-19T16:31:00.000Z",
    stem: `check-identity-correction-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: segments.reduce((n, x) => n + x.text.length, 0), countedFrom: "check-identity-correction" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...extra,
  };
}

const answer = (answeredAt: string, guests: string[], scope: "work" | "personal", corrects?: string) => ({
  identity_version: 2,
  answered_at: answeredAt,
  self: { name: "Check Host", source: "recorder_identity_prompt" },
  guests: guests.map((name) => ({ name })),
  scope,
  ...(corrects !== undefined ? { corrects } : {}),
});

async function main(): Promise<void> {
  await refuseUnlessScratch("check-identity-correction");
  process.env.ANTHROPIC_API_KEY = "stub-key";
  const fx = await makeAccount("check-identity-correction");
  const ctx = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: "check@clipwise.test", scope: ["clipwise:capture"] };
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = ctx as typeof req.access;
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
  // Everything a correction writes, as one comparable string.
  const snapshot = async (rec: string): Promise<string> => {
    const q = async (sql: string) => (await pool.query(sql, [rec])).rows;
    return JSON.stringify({
      attendees: await q(`select name, is_host from attendees where recording_id = $1 order by is_host desc, name`),
      speakers: await q(`select label, display_name from speakers where recording_id = $1 order by label`),
      recording: await q(`select scope, metadata->'identity' as identity from recordings where id = $1`),
    });
  };
  const reextracts = async (rec: string): Promise<number> =>
    (await pool.query(`select count(*)::int as n from jobs where recording_id = $1 and kind = 're_extract'`, [rec])).rows[0].n;
  const clearReextracts = async (rec: string): Promise<void> => {
    await pool.query(`delete from jobs where recording_id = $1 and kind = 're_extract'`, [rec]);
  };
  const speaker = async (rec: string, label: string): Promise<string | null> =>
    (await pool.query(`select display_name from speakers where recording_id = $1 and label = $2`, [rec, label])).rows[0]?.display_name ?? null;
  const findsByAttendee = async (rec: string, attendee: string): Promise<boolean> => {
    const result = (await searchMoments(ctx as Parameters<typeof searchMoments>[0], { index: true, attendee, scope: "all" })) as { recordings?: Array<{ id: string }> };
    return (result.recordings ?? []).some((r) => r.id === rec);
  };
  // A complete first extraction, so a late change re-extracts (jobs/enqueue.ts).
  const extractOnce = async (rec: string, segments: number): Promise<void> => {
    const stub = makeStubModel({ segmentCount: segments, phrase: "check-identity-correction" });
    await runExtraction(rec, { client: stub.client });
  };

  try {
    // m. the plan's case.
    const A = "2026-10-19T16:50:00.000Z";
    const B = "2026-10-25T10:00:00.000Z";
    const pm = payload(ONE_TO_ONE, { identity: answer(A, ["Wiliam Example"], "work") });
    const rm0 = await post(pm);
    const recm = String(rm0.json.recordingId);
    check("m: the first send stores the call (201)", rm0.status === 201, `${rm0.status} ${JSON.stringify(rm0.json)}`);
    await extractOnce(recm, ONE_TO_ONE.length);
    check("m: control: before the correction, the search finds the call by the old name", await findsByAttendee(recm, "Wiliam Example"));
    const rm = await post({ ...pm, identity: answer(B, ["William Example"], "personal", A) });
    const attendeesM = (await pool.query(`select name, is_host from attendees where recording_id = $1 order by is_host desc, name`, [recm])).rows;
    const scopeM = (await pool.query(`select scope from recordings where id = $1`, [recm])).rows[0].scope;
    check("m: the correction is applied (200, identityApplied)", rm.status === 200 && rm.json.identityApplied === true, `${rm.status} ${JSON.stringify(rm.json)}`);
    check(
      "m: attendees are replaced: the host and William Example only",
      JSON.stringify(attendeesM) === JSON.stringify([{ name: "Check Host", is_host: true }, { name: "William Example", is_host: false }]),
      JSON.stringify(attendeesM),
    );
    check("m: `them` is William Example and `me` the host", (await speaker(recm, "them")) === "William Example" && (await speaker(recm, "me")) === "Check Host");
    check("m: scope is overwritten to personal", scopeM === "personal", String(scopeM));
    check("m: one re_extract is queued", (await reextracts(recm)) === 1, String(await reextracts(recm)));
    check("m: the search finds the call by William Example", await findsByAttendee(recm, "William Example"));
    check("m: and not by Wiliam Example", !(await findsByAttendee(recm, "Wiliam Example")));

    // r. the same correction again, as after a lost reply.
    await clearReextracts(recm);
    const beforeR = await snapshot(recm);
    const rr = await post({ ...pm, identity: answer(B, ["William Example"], "personal", A) });
    check("r: the same correction sent again is 200, not applied again, not 409", rr.status === 200 && rr.json.identityApplied === false, `${rr.status} ${JSON.stringify(rr.json)}`);
    check("r: and writes nothing, queues nothing", (await snapshot(recm)) === beforeR && (await reextracts(recm)) === 0);

    // u. control: a correction that changes nothing.
    const C = "2026-10-25T10:05:00.000Z";
    const ru = await post({ ...pm, identity: answer(C, ["William Example"], "personal", B) });
    check("u: an unchanged correction is applied (200, identityApplied)", ru.status === 200 && ru.json.identityApplied === true, `${ru.status} ${JSON.stringify(ru.json)}`);
    check("u: control: it queues no re_extract (m queued one when the name changed)", (await reextracts(recm)) === 0, String(await reextracts(recm)));

    // s. control: a correction of an answer the recording no longer holds.
    const beforeS = await snapshot(recm);
    const rs = await post({ ...pm, identity: answer("2026-10-25T10:10:00.000Z", ["Someone Else"], "work", A) });
    check("s: a stale correction gets 409 identity_correction_stale", rs.status === 409 && rs.json.error === "identity_correction_stale", `${rs.status} ${JSON.stringify(rs.json)}`);
    check("s: and nothing is written: attendees, speakers, scope and the stored answer as before", (await snapshot(recm)) === beforeS && (await reextracts(recm)) === 0);

    // o. two corrections made offline. The server holds A; B1 was made and never
    // sent; B2 was made after it. The queue sends only B2.
    const po = payload(ONE_TO_ONE, { identity: answer(A, ["Ann Example"], "work") });
    const ro0 = await post(po);
    const reco = String(ro0.json.recordingId);
    const B1 = "2026-10-25T11:00:00.000Z";
    const B2 = "2026-10-25T11:05:00.000Z";
    const beforeO = await snapshot(reco);
    const roWrong = await post({ ...po, identity: answer(B2, ["Bob Example"], "work", B1) });
    check("o: control: B2 carrying B1's answered_at, which the server never saw, gets 409", roWrong.status === 409 && roWrong.json.error === "identity_correction_stale", `${roWrong.status} ${JSON.stringify(roWrong.json)}`);
    check("o: control: and writes nothing", (await snapshot(reco)) === beforeO);
    const ro = await post({ ...po, identity: answer(B2, ["Bob Example"], "work", A) });
    check("o: B2 carrying A forward (the stored answer) is applied", ro.status === 200 && ro.json.identityApplied === true && (await speaker(reco, "them")) === "Bob Example", `${ro.status} ${JSON.stringify(ro.json)}`);

    // n. no stored answer: the correction applies as the first answer.
    const pn = payload(ONE_TO_ONE);
    const rn0 = await post(pn);
    const recn = String(rn0.json.recordingId);
    const rn = await post({ ...pn, identity: answer(B, ["Cat Example"], "work", "2026-10-19T16:50:00.000Z") });
    check("n: with no stored answer, a correction applies as the first answer", rn.status === 200 && rn.json.identityApplied === true && (await speaker(recn, "them")) === "Cat Example", `${rn.status} ${JSON.stringify(rn.json)}`);

    // v. a group call with named voices; the correction removes Bob.
    const voiceNames = { answered_at: "2026-10-19T17:00:00.000Z", voices: [{ voiceIndex: 1, name: "Ann Example" }, { voiceIndex: 2, name: "Bob Example" }, { voiceIndex: 3, name: "Cy Example" }] };
    const pv = payload(GROUP, { voices: VOICES, identity: answer(A, ["Ann Example", "Bob Example", "Cy Example"], "work"), voiceNames });
    const rv0 = await post(pv);
    const recv = String(rv0.json.recordingId);
    const named = async () => (await pool.query(`select label, display_name from speakers where recording_id = $1 and label ~ '^Voice [0-9]+$' order by label`, [recv])).rows.map((r) => `${r.label}=${r.display_name ?? "(unnamed)"}`).join(",");
    check("v: control: before the correction, Voice 1..3 are Ann, Bob and Cy", (await named()) === "Voice 1=Ann Example,Voice 2=Bob Example,Voice 3=Cy Example", await named());
    const rv = await post({ ...pv, identity: answer(B, ["Ann Example", "  Cy Example  ", "Dee Example"], "work", A) });
    check("v: the correction is applied (200)", rv.status === 200 && rv.json.identityApplied === true, `${rv.status} ${JSON.stringify(rv.json)}`);
    check("v: Bob's voice is unnamed; Ann's and Cy's keep their names (Cy sent with stray spaces)", (await named()) === "Voice 1=Ann Example,Voice 2=(unnamed),Voice 3=Cy Example", await named());
  } finally {
    server.close();
    await dropAccount(fx);
    await endPool();
  }
  console.log(failures === 0 ? "\ncheck-identity-correction: all passed" : `\ncheck-identity-correction: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`check-identity-correction: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
