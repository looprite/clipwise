// SAA-370 step 1: a capture is ready once its transcript is stored, not once
// extraction finishes. POST /captures writes status, duration_sec and ended_at
// (extract.ts READY_COLUMNS) in the transaction that stores the transcript; the
// promotion writes the same values again; a failed extraction writes nothing to
// the recording.
//
//   a  a capture just stored, no worker run yet: ready, duration_sec the longest
//      track's duration_s, ended_at started_at plus that, no current run, one extract
//      job queued
//   b  that capture's extraction then fails (three 400s from the stub model): the
//      job is failed, and status, duration_sec and ended_at are exactly what a
//      read them
//   c  a second capture whose extraction succeeds: the job is done and a current
//      run is set, and status, duration_sec and ended_at are exactly what they
//      were right after its POST
//
// Values are compared as the database prints them (duration_sec::text, ended_at
// in UTC as text), so "unchanged" means byte for byte.
//
// Control: comment out the tx.update(...).set(READY_COLUMNS) line in
// routes/captures.ts and run this again: a and b fail.
//
// Invented names and content only. Writes to the database: run it through
// scratch-db.sh, which refuses anything but the scratch branch.
//
//   scripts/scratch-db.sh run check-ready-at-upload

import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { makeStubEmbedder, makeStubModel } from "../extract/stub-model.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { capturesPost } from "./captures.js";
import { errorHandler } from "../lib/http.js";
import { JobWorker } from "../jobs/worker.js";

const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  say(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PHRASE = "TEAL-OTTER-2093";
const STARTED_AT = "2026-10-10T10:00:00.000Z";
// The longest track is the system tap's; the mic stops a quarter second earlier.
const WANT_DURATION = "600.5";
const WANT_ENDED_UTC = "2026-10-10 10:10:00.5";

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string };
const SEGS: Seg[] = [
  { track: "me", startMs: 0, endMs: 1500, text: "morning, shall we look at the plan" },
  { track: "them", startMs: 1600, endMs: 3000, text: "yes, the draft is ready" },
  { track: "me", startMs: 3100, endMs: 4000, text: "good, send it over" },
  { track: "them", startMs: 4100, endMs: 5000, text: "will do" },
];
const TRACKS = [
  { track: "system", file: "system-x.f32le.pcm", encoding: "f32le", container: "raw", channels: 1, sample_rate: 48000, sample_rate_source: "systemtap_reported_tap_format", device_name: "Out", device_uid: "out-uid", duration_s: 600.5 },
  { track: "mic", file: "mic-x.wav", encoding: "f32le", container: "wav", sample_rate: 48000, sample_rate_source: "wav_fmt_chunk_readback", device_name: "In", device_uid: "in-uid", duration_s: 600.25 },
];
const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 600, gaps: [], note: "check" });

function payload(): Record<string, unknown> {
  const id = randomUUID().toUpperCase();
  return {
    captureId: id,
    startedAt: STARTED_AT,
    stem: `check-ready-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments: SEGS,
    sourceFidelity: { declaredTurnCount: SEGS.length, declaredBodyChars: SEGS.reduce((n, x) => n + x.text.length, 0), countedFrom: "check-ready-at-upload" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { tracks: TRACKS, permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    identity: { answered_at: "2026-10-10T10:11:00Z", self: { name: "Host Name", source: "check" }, guests: [{ name: "Guest One" }], scope: "work" },
  };
}

type Row = { status: string; duration: string | null; ended: string | null; run: string | null };

async function main(): Promise<void> {
  await refuseUnlessScratch("check-ready-at-upload");
  process.env.ANTHROPIC_API_KEY = "stub-key";
  // The worker claims any job in the table, so the run starts from an empty one
  // (refuseUnlessScratch has already refused anything but the scratch database).
  const leftovers = await pool.query("delete from jobs");
  say(`check-ready-at-upload: emptied the jobs table before starting (${leftovers.rowCount} leftover row(s))`);
  const fx: Fixture = await makeAccount("check-ready");

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
  const rowOf = async (recordingId: string): Promise<Row> => {
    const r = await pool.query(
      `select status, duration_sec::text as duration, (ended_at at time zone 'UTC')::text as ended,
              metadata->>'current_extraction_run' as run
       from recordings where id = $1`,
      [recordingId],
    );
    return r.rows[0];
  };
  const jobsOf = (recordingId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.recordingId, recordingId)).orderBy(schema.jobs.createdAt);
  const settle = async (recordingId: string, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const js = await jobsOf(recordingId);
      if (js.length > 0 && js.every((j) => j.state === "done" || j.state === "failed")) return js;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for the jobs of ${recordingId}: ${JSON.stringify(js.map((j) => [j.kind, j.state, j.attempts]))}`);
      await sleep(25);
    }
  };
  const workers: JobWorker[] = [];
  const runToEnd = async (stub: ReturnType<typeof makeStubModel>, recordingId: string) => {
    const w = new JobWorker({ anthropicFetch: stub.fetch, embedder: makeStubEmbedder(), renewMs: 200, leaseMs: 10_000, backoffMs: [40, 40], passingBackoffMs: [40, 40, 40, 40, 40, 40] });
    workers.push(w);
    w.wake();
    const jobs = await settle(recordingId);
    await w.stop();
    return jobs;
  };
  const model = (o: { failStatus?: number } = {}) => makeStubModel({ segmentCount: SEGS.length, phrase: PHRASE, ...o });
  const wanted = (r: Row | undefined): boolean => !!r && r.status === "ready" && r.duration === WANT_DURATION && r.ended === WANT_ENDED_UTC;
  const same = (x: Row | undefined, y: Row | undefined): boolean => !!x && !!y && x.status === y.status && x.duration === y.duration && x.ended === y.ended;

  try {
    // ---- a ---------------------------------------------------------------------
    const pa = await post(payload());
    const ra = String(pa.json.recordingId);
    const rowA = await rowOf(ra);
    const jobsA = await jobsOf(ra);
    check("a POST /captures answers 201", pa.status === 201, JSON.stringify({ status: pa.status, error: pa.json.error }));
    check(
      `a straight after the upload, before any extraction: status ready, duration_sec ${WANT_DURATION}, ended_at ${WANT_ENDED_UTC} UTC`,
      wanted(rowA),
      JSON.stringify(rowA),
    );
    check("a no current run yet, and one extract job queued", !!rowA && rowA.run === null && jobsA.length === 1 && jobsA[0].kind === "extract" && jobsA[0].state === "queued", JSON.stringify({ run: rowA?.run, jobs: jobsA.map((j) => [j.kind, j.state]) }));

    // ---- b ---------------------------------------------------------------------
    const failing = model({ failStatus: 400 });
    const jobsB = await runToEnd(failing, ra);
    const rowB = await rowOf(ra);
    check("b the extraction fails: the job is failed after 3 attempts", jobsB.length === 1 && jobsB[0].state === "failed" && jobsB[0].attempts === 3, JSON.stringify(jobsB.map((j) => [j.kind, j.state, j.attempts, j.errorClass])));
    check("b the recording is still ready, with duration_sec and ended_at exactly as a read them, and no current run", wanted(rowB) && same(rowA, rowB) && rowB.run === null, JSON.stringify({ a: rowA, b: rowB }));

    // ---- c ---------------------------------------------------------------------
    const pc = await post(payload());
    const rc = String(pc.json.recordingId);
    const rowC0 = await rowOf(rc);
    const jobsC = await runToEnd(model(), rc);
    const rowC = await rowOf(rc);
    check("c a second capture is ready straight after its upload", pc.status === 201 && wanted(rowC0), JSON.stringify({ status: pc.status, row: rowC0 }));
    check("c the extraction succeeds: the job is done and a current run is set", jobsC.length === 1 && jobsC[0].state === "done" && !!rowC && rowC.run !== null, JSON.stringify({ jobs: jobsC.map((j) => [j.kind, j.state, j.attempts]), run: rowC?.run }));
    check("c status, duration_sec and ended_at are exactly what they were right after the upload", wanted(rowC) && same(rowC0, rowC), JSON.stringify({ afterUpload: rowC0, afterExtraction: rowC }));
  } finally {
    const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        failures++;
        say(`check-ready-at-upload: cleanup step "${what}" failed: ${firstLine(e)}`);
      }
    };
    await attempt("stop the workers", () => Promise.all(workers.map((w) => w.stop())));
    await attempt("close the server", async () => {
      server.close();
    });
    await attempt("drop the run's account", () => dropAccount(fx));
    await attempt("end the pool", () => endPool());
  }
  say(failures === 0 ? "\ncheck-ready-at-upload: all passed" : `\ncheck-ready-at-upload: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  say(`check-ready-at-upload: crashed: ${err instanceof Error ? (err.stack ?? err.message).split("\n").slice(0, 4).join(" | ") : String(err)}`);
  process.exit(1);
});
