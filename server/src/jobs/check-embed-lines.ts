// SAA-370 step 2: transcript windows embedded by a hidden job, embed_lines.
//
// The design (SAA-370 step 2, decided 11-28): a call's shown transcript lines
// are cut into windows of 8, stepping 4 (window_rule "lines8-step4"); each
// window's text is its lines' words joined by "\n", with no speaker names and no
// times; it is embedded with input_type "document" by voyage-4 and stored in
// transcript_windows (no text, segment numbers first_segment..last_segment as
// get_transcript numbers them). POST /captures queues the job in the upload's
// transaction; GET /captures/:captureId/jobs never lists it; the worker takes it
// only when no other kind is runnable; Voyage 429/5xx are passing conditions.
//
//   e1  an upload queues extract and embed_lines, both in the upload's
//       transaction (created_at equal to the recording's)
//   e2  GET /captures/:captureId/jobs lists extract only, not embed_lines
//   e3  21 segments with #5 empty and one line of runs of spaces: windows
//       [0,8] [4,12] [9,16] [13,20]; each window's text sent to Voyage is its
//       shown lines' words, whitespace collapsed, joined by "\n", no names or
//       times; input_type document, model voyage-4; each stored row has model
//       voyage-4, rule lines8-step4, 1024 dimensions, and the vector of exactly
//       that text
//   e4  1, 8 and 9 shown lines give [0,0], [0,7], [0,7]+[4,8]; no segments gives
//       a done job and no windows
//   e5  transcript_windows has no text column, and no row holds a word of a line
//   e6  four 429s from Voyage, then an answer: the job is done on attempt 5
//       (the passing ladder; the ordinary one fails at 3), with its window, and
//       the jobs route still lists extract only
//   e7  the recording deleted while its window embedding is in flight: no
//       windows left for it, and the worker goes on to finish the next call
//   e8  a late identity answer on a repeat upload: no new embed_lines job, no
//       new Voyage request for that call, windows byte-identical
//   e9  claim order: of two uploads, the second's extract starts before the
//       first's embed_lines
//   e10 jobs embed-backlog lists a call with segments and no windows or job;
//       --queue queues exactly one embed_lines job for it; a second run no longer
//       lists it, nor a call that already has windows
//   e11 no line written by the server, worker or CLI during the run holds a word
//       of a line. Control: those words reached Voyage
//
// Voyage is a stub at the fetch boundary (api.voyageai.com only), so the real
// lib/voyage.ts embed() and its error path run. Extraction is a stub that
// answers 400, so extract jobs fail fast and never call Voyage: every Voyage
// request here is the window embedding. The stub's vector is a bag of words, so
// a stored vector can be tied to the text it was made from.
//
// Proof by breaking, once the build exists (each should turn its case FAIL):
//   e2  drop the embed_lines filter from the jobs route
//   e3  embed with input_type "query" in the window job
//   e6  leave Voyage errors out of passingApiCondition
//   e9  drop the claim-order term from the worker's claim
//
// Invented names and content only. Writes to the database: run it through
// scratch-db.sh, which refuses anything but the scratch branch.
//
//   scripts/scratch-db.sh run check-embed-lines

import express from "express";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { makeStubModel } from "../extract/stub-model.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { capturesPost } from "../routes/captures.js";
import { captureScopeRouter } from "../routes/capture-scope.js";
import { errorHandler } from "../lib/http.js";
import { JobWorker } from "./worker.js";

const WHO = "check-embed-lines";
const WINDOW_RULE = "lines8-step4";
const MODEL = "voyage-4";

const out = process.stdout.write.bind(process.stdout);
const say = (s: string): void => {
  out(`${s}\n`);
};
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  say(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail.slice(0, 600)}`}`);
  if (!ok) failures++;
}
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- what the server writes while it works (tee'd, so it still shows) ---------
const logged: string[] = [];
async function watched<T>(fn: () => Promise<T>): Promise<T> {
  const err = process.stderr.write.bind(process.stderr);
  const tee = (write: typeof out) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = tee(out);
  process.stderr.write = tee(err);
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

// ---- Voyage, stubbed at the fetch boundary -------------------------------------
type VoyageReq = { input: string[]; input_type: string; model: string };
const voyage = {
  requests: [] as VoyageReq[],
  fail429: 0,
  hold: null as null | { word: string; seen: () => void; release: Promise<void> },
};

// A bag of words, so that a stored vector can be tied to its text.
function vectorOf(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  v[0] = 0.01;
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    v[1 + (h % 1023)] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
const literal = (v: number[]): string => `[${v.join(",")}]`;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.voyageai.com/")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}")) as VoyageReq;
  voyage.requests.push(body);
  if (voyage.fail429 > 0) {
    voyage.fail429--;
    return new Response(JSON.stringify({ detail: "stub rate limit" }), { status: 429, headers: { "content-type": "application/json" } });
  }
  const h = voyage.hold;
  if (h && body.input.some((t) => t.includes(h.word))) {
    h.seen();
    await h.release;
  }
  return new Response(
    JSON.stringify({ object: "list", data: body.input.map((t, i) => ({ object: "embedding", embedding: vectorOf(t), index: i })), model: body.model, usage: { total_tokens: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

// ---- the window rule, written out ------------------------------------------------
const collapse = (t: string): string => t.replace(/\s+/g, " ").trim();
type Win = { first: number; last: number; text: string };
function expectedWindows(texts: string[]): Win[] {
  const shown = texts.flatMap((t, i) => (collapse(t) === "" ? [] : [i]));
  const m = shown.length;
  const outW: Win[] = [];
  if (m === 0) return outW;
  for (let s = 0; ; s += 4) {
    const e = Math.min(s + 7, m - 1);
    outW.push({ first: shown[s], last: shown[e], text: shown.slice(s, e + 1).map((i) => collapse(texts[i])).join("\n") });
    if (e === m - 1) break;
  }
  return outW;
}

// Invented words, one family per call, so a log line or a row holding one is
// easy to spot.
const WORDS = ["quillmoss", "tarnbeck", "saltmarsh", "brindlecove", "ferrowind", "pellucid", "gorsewick", "marrowdale", "thistlegate", "copperfen"];
const linesWith = (word: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${word} point ${i} about the ${word} rollout`);

// ---- uploads ---------------------------------------------------------------------
const STARTED_AT = "2026-10-12T14:00:00.000Z";
const TRACKS = [
  { track: "system", file: "system-x.f32le.pcm", encoding: "f32le", container: "raw", channels: 1, sample_rate: 48000, sample_rate_source: "systemtap_reported_tap_format", device_name: "Out", device_uid: "out-uid", duration_s: 300 },
  { track: "mic", file: "mic-x.wav", encoding: "f32le", container: "wav", sample_rate: 48000, sample_rate_source: "wav_fmt_chunk_readback", device_name: "In", device_uid: "in-uid", duration_s: 299.5 },
];
const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 300, gaps: [], note: "check" });
function payload(texts: string[], o: { captureId?: string; identity?: boolean } = {}): Record<string, unknown> {
  const id = o.captureId ?? randomUUID().toUpperCase();
  const segments = texts.map((text, i) => ({ track: i % 2 === 0 ? "me" : "them", startMs: i * 2000, endMs: i * 2000 + 1500, text }));
  return {
    captureId: id,
    startedAt: STARTED_AT,
    stem: `check-embed-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: texts.reduce((n, t) => n + t.length, 0), countedFrom: WHO },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { tracks: TRACKS, permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...(o.identity ? { identity: { answered_at: "2026-10-12T14:06:00Z", self: { name: "Robin Ashgrove", source: "check" }, guests: [{ name: "Tamsin Vell" }], scope: "work" } } : {}),
  };
}

type JobRow = { kind: string; state: string; attempts: number; created: string; started: string | null };

async function main(): Promise<void> {
  await refuseUnlessScratch(WHO);
  process.env.ANTHROPIC_API_KEY = "stub-key";
  process.env.VOYAGE_API_KEY = "stub-voyage-key";
  // The worker claims any job in the table, so the run starts from an empty one
  // (refuseUnlessScratch has already refused anything but the scratch database).
  const leftovers = await pool.query("delete from jobs");
  say(`${WHO}: emptied the jobs table before starting (${leftovers.rowCount} leftover row(s))`);
  const fx: Fixture = await makeAccount(WHO);

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: "check@clipwise.test", scope: ["clipwise:capture"] };
    next();
  });
  app.post("/captures", capturesPost);
  app.use(captureScopeRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const post = (body: Record<string, unknown>) =>
    watched(async () => {
      const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown>, captureId: String(body.captureId) };
    });
  const routeKinds = async (captureId: string): Promise<string[] | string> => {
    const res = await fetch(`${base}/captures/${captureId}/jobs`);
    if (!res.ok) return `HTTP ${res.status}`;
    const j = (await res.json()) as { jobs?: Array<{ kind: string }> };
    return (j.jobs ?? []).map((x) => x.kind);
  };
  const jobsOf = async (recordingId: string): Promise<JobRow[]> =>
    (
      await pool.query<JobRow>(
        `select kind, state, attempts, created_at::text as created, started_at::text as started from jobs where recording_id = $1 order by created_at, kind`,
        [recordingId],
      )
    ).rows;
  const windowsOf = async (recordingId: string) =>
    (
      await pool.query<{ id: string; first: number; last: number; model: string; rule: string; dims: number; vec: string; created: string }>(
        `select id, first_segment as first, last_segment as last, embedding_model as model, window_rule as rule,
                vector_dims(embedding) as dims, embedding::text as vec, created_at::text as created
           from transcript_windows where recording_id = $1 order by first_segment`,
        [recordingId],
      )
    ).rows;
  const hasTable = (await pool.query<{ t: string | null }>(`select to_regclass('public.transcript_windows')::text as t`)).rows[0].t !== null;
  check("transcript_windows exists", hasTable);
  const safeWindows = async (recordingId: string) => (hasTable ? windowsOf(recordingId) : []);

  const workers: JobWorker[] = [];
  const failingModel = makeStubModel({ segmentCount: 1, phrase: "check", failStatus: 400 });
  const newWorker = () => {
    const w = new JobWorker({ anthropicFetch: failingModel.fetch, renewMs: 200, leaseMs: 10_000, backoffMs: [40, 40], passingBackoffMs: [40, 40, 40, 40, 40, 40] });
    workers.push(w);
    return w;
  };
  const settled = (js: JobRow[]) => js.length > 0 && js.every((j) => j.state === "done" || j.state === "failed");
  const settle = async (ids: string[], ms = 30_000): Promise<void> => {
    const t0 = Date.now();
    for (;;) {
      const all = await Promise.all(ids.map(jobsOf));
      if (all.every(settled)) return;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for jobs: ${JSON.stringify(all.map((js) => js.map((j) => [j.kind, j.state, j.attempts])))}`);
      await sleep(25);
    }
  };
  const runToEnd = (ids: string[]) =>
    watched(async () => {
      const w = newWorker();
      w.wake();
      try {
        await settle(ids);
      } finally {
        await w.stop();
      }
    });

  // A recording written directly (no upload), for the window-shape cases.
  const addCall = async (texts: string[]): Promise<{ id: string }> => {
    const id = randomUUID();
    await db.insert(schema.recordings).values({ id, accountId: fx.accountId, ownerMemberId: fx.memberId, slug: `check-${fx.tag}-${id.slice(0, 8)}`, title: "Check call", source: "check", sourceId: id, status: "ready", visibility: "private", scope: "work", startedAt: new Date(STARTED_AT), metadata: {} });
    const [t] = await db.insert(schema.transcripts).values({ recordingId: id, provider: "check", language: "en", status: "ready" }).returning();
    const [me] = await db.insert(schema.speakers).values({ recordingId: id, label: "me" }).returning();
    const [them] = await db.insert(schema.speakers).values({ recordingId: id, label: "them", displayName: "Tamsin Vell" }).returning();
    if (texts.length > 0) {
      await db.insert(schema.segments).values(
        texts.map((text, i) => ({ accountId: fx.accountId, recordingId: id, transcriptId: t.id, speakerId: i % 2 === 0 ? me.id : them.id, startSec: i * 5, endSec: i * 5 + 4, text, orderIndex: i })),
      );
    }
    return { id };
  };
  const queueEmbed = async (recordingId: string): Promise<string | null> => {
    try {
      await pool.query(`insert into jobs (account_id, recording_id, kind) values ($1, $2, 'embed_lines')`, [fx.accountId, recordingId]);
      return null;
    } catch (e) {
      return firstLine(e);
    }
  };
  // The window texts Voyage was sent, as document requests.
  const sentDocs = () => voyage.requests.filter((r) => r.input_type === "document").flatMap((r) => r.input);
  const vectorIs = async (windowId: string, text: string): Promise<boolean> =>
    (await pool.query<{ d: number }>(`select (embedding <=> $2::vector)::float8 as d from transcript_windows where id = $1`, [windowId, literal(vectorOf(text))])).rows[0]?.d < 1e-5;

  const tsx = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "node_modules/.bin/tsx");
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const backlog = (args: string[]) =>
    watched(async () => {
      const r = spawnSync(tsx, ["src/jobs/cli.ts", "embed-backlog", ...args], { cwd: serverDir, env: process.env, encoding: "utf8" });
      logged.push(r.stdout ?? "", r.stderr ?? "");
      return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    });

  try {
    // ---- e1, e2 ------------------------------------------------------------------
    const p1 = await post(payload(linesWith(WORDS[0], 8)));
    const r1 = String(p1.json.recordingId);
    check("e1 POST /captures answers 201", p1.status === 201, JSON.stringify({ status: p1.status, error: p1.json.error }));
    const recCreated = (await pool.query<{ c: string }>(`select created_at::text as c from recordings where id = $1`, [r1])).rows[0]?.c;
    const j1 = await jobsOf(r1);
    check(
      "e1 the upload queues extract and embed_lines, both in the upload's transaction",
      JSON.stringify(j1.map((j) => j.kind).sort()) === JSON.stringify(["embed_lines", "extract"]) && j1.every((j) => j.state === "queued" && j.created === recCreated),
      JSON.stringify({ recCreated, jobs: j1 }),
    );
    const kinds1 = await routeKinds(p1.captureId);
    check("e2 control: the jobs route answers for this capture", Array.isArray(kinds1), String(kinds1));
    check("e2 GET /captures/:captureId/jobs lists extract only, not embed_lines", JSON.stringify(kinds1) === JSON.stringify(["extract"]), JSON.stringify(kinds1));

    // ---- e3, e4 ------------------------------------------------------------------
    const t21 = Array.from({ length: 21 }, (_, i) => `${WORDS[1]} line ${i} on the ${WORDS[1]} budget`);
    t21[5] = "";
    t21[9] = `  ${WORDS[1]}   line 9    with   runs of  spaces  `;
    const c21 = await addCall(t21);
    const c1 = await addCall(linesWith(WORDS[4], 1));
    const c8 = await addCall(linesWith(WORDS[5], 8));
    const c9 = await addCall(linesWith(WORDS[6], 9));
    const c0 = await addCall([]);
    const queued = await Promise.all([c21, c1, c8, c9, c0].map((c) => queueEmbed(c.id)));
    check("e3 control: an embed_lines job can be queued", queued.every((q) => q === null), JSON.stringify(queued));
    await pool.query(`delete from jobs where kind <> 'embed_lines'`);
    if (queued.every((q) => q === null)) await runToEnd([c21.id, c1.id, c8.id, c9.id, c0.id]).catch((e) => check("e3 the window jobs settle", false, firstLine(e)));

    const want21 = expectedWindows(t21);
    check("e3 control: the rule written out gives [0,8] [4,12] [9,16] [13,20]", JSON.stringify(want21.map((w) => [w.first, w.last])) === "[[0,8],[4,12],[9,16],[13,20]]", JSON.stringify(want21.map((w) => [w.first, w.last])));
    const w21 = await safeWindows(c21.id);
    check("e3 21 segments with #5 empty: windows [0,8] [4,12] [9,16] [13,20]", JSON.stringify(w21.map((w) => [w.first, w.last])) === "[[0,8],[4,12],[9,16],[13,20]]", JSON.stringify(w21.map((w) => [w.first, w.last])));
    const docs = sentDocs();
    check(
      "e3 each window's text was sent to Voyage exactly: words collapsed, joined by \\n, no names, no times",
      want21.every((w) => docs.filter((d) => d === w.text).length === 1) && !docs.some((d) => d.includes("Tamsin") || /\b\d+:\d\d\b/.test(d)),
      JSON.stringify(docs.filter((d) => d.includes(WORDS[1])).slice(0, 2)),
    );
    const mine = voyage.requests.filter((r) => r.input.some((t) => t.includes(WORDS[1])));
    check("e3 those requests were input_type document, model voyage-4", mine.length > 0 && mine.every((r) => r.input_type === "document" && r.model === MODEL), JSON.stringify(mine.map((r) => [r.input_type, r.model])));
    check("e3 each row: model voyage-4, rule lines8-step4, 1024 dimensions", w21.length === 4 && w21.every((w) => w.model === MODEL && w.rule === WINDOW_RULE && w.dims === 1024), JSON.stringify(w21.map((w) => [w.model, w.rule, w.dims])));
    const vecOk = w21.length === 4 && (await Promise.all(w21.map((w, i) => vectorIs(w.id, want21[i].text)))).every(Boolean);
    check("e3 each row's vector is the vector of exactly its window's text", vecOk);

    const shape = async (c: { id: string }) => JSON.stringify((await safeWindows(c.id)).map((w) => [w.first, w.last]));
    check("e4 1 shown line: [0,0]", (await shape(c1)) === "[[0,0]]", await shape(c1));
    check("e4 8 shown lines: [0,7]", (await shape(c8)) === "[[0,7]]", await shape(c8));
    check("e4 9 shown lines: [0,7] [4,8]", (await shape(c9)) === "[[0,7],[4,8]]", await shape(c9));
    const j0 = await jobsOf(c0.id);
    check("e4 no segments: the job is done and there are no windows", j0.length === 1 && j0[0].state === "done" && (await shape(c0)) === "[]", JSON.stringify({ jobs: j0, windows: await shape(c0) }));

    // ---- e6 ----------------------------------------------------------------------
    const p6 = await post(payload(linesWith(WORDS[2], 8)));
    const r6 = String(p6.json.recordingId);
    voyage.fail429 = 4;
    await runToEnd([r6]).catch((e) => check("e6 the jobs settle", false, firstLine(e)));
    voyage.fail429 = 0;
    const e6 = (await jobsOf(r6)).find((j) => j.kind === "embed_lines");
    check("e6 four 429s, then an answer: embed_lines is done on attempt 5", e6?.state === "done" && e6.attempts === 5, JSON.stringify(e6));
    check("e6 its window is stored", (await safeWindows(r6)).length === 1, String((await safeWindows(r6)).length));
    check("e6 the jobs route still lists extract only", JSON.stringify(await routeKinds(p6.captureId)) === JSON.stringify(["extract"]), JSON.stringify(await routeKinds(p6.captureId)));

    // ---- e7 ----------------------------------------------------------------------
    const p7 = await post(payload(linesWith(WORDS[3], 8)));
    const r7 = String(p7.json.recordingId);
    const p7b = await post(payload(linesWith(WORDS[7], 8)));
    const r7b = String(p7b.json.recordingId);
    let seen!: () => void;
    const reached = new Promise<void>((r) => (seen = r));
    let release!: () => void;
    voyage.hold = { word: WORDS[3], seen: () => seen(), release: new Promise<void>((r) => (release = r)) };
    await watched(async () => {
      const w = newWorker();
      w.wake();
      try {
        const got = await Promise.race([reached.then(() => true), sleep(20_000).then(() => false)]);
        check("e7 control: the window embedding for the call to delete was in flight", got);
        await db.delete(schema.recordings).where(eq(schema.recordings.id, r7));
        release();
        await settle([r7b]);
      } catch (e) {
        check("e7 the next call's jobs settle", false, firstLine(e));
      } finally {
        release?.();
        voyage.hold = null;
        await w.stop();
      }
    });
    const left7 = hasTable ? (await pool.query(`select count(*)::int as n from transcript_windows where recording_id = $1`, [r7])).rows[0].n : -1;
    check("e7 no windows are left for the deleted recording", left7 === 0, String(left7));
    const next7 = (await jobsOf(r7b)).find((j) => j.kind === "embed_lines");
    check("e7 the worker went on: the next call's embed_lines is done, with its window", next7?.state === "done" && (await safeWindows(r7b)).length === 1, JSON.stringify(next7));

    // ---- e8 ----------------------------------------------------------------------
    const t8 = linesWith(WORDS[8], 8);
    const p8 = await post(payload(t8));
    const r8 = String(p8.json.recordingId);
    await runToEnd([r8]).catch((e) => check("e8 the jobs settle", false, firstLine(e)));
    const before8 = await safeWindows(r8);
    const sent8 = voyage.requests.filter((r) => r.input.some((t) => t.includes(WORDS[8]))).length;
    const repeat = await post(payload(t8, { captureId: p8.captureId, identity: true }));
    check("e8 control: the repeat upload with an identity answer is accepted as a repeat", repeat.status === 200 && repeat.json.created === false, JSON.stringify({ status: repeat.status, created: repeat.json.created, error: repeat.json.error }));
    await runToEnd([r8]).catch((e) => check("e8 the jobs settle after the repeat", false, firstLine(e)));
    const after8 = await safeWindows(r8);
    const embedJobs8 = (await jobsOf(r8)).filter((j) => j.kind === "embed_lines");
    check("e8 control: the call has its window", before8.length === 1, String(before8.length));
    check("e8 no new embed_lines job for the late answer", embedJobs8.length === 1, JSON.stringify(embedJobs8));
    check("e8 no new Voyage request for that call", voyage.requests.filter((r) => r.input.some((t) => t.includes(WORDS[8]))).length === sent8 && sent8 === 1, String(sent8));
    check("e8 the call's one window is byte-identical (id, vector, time)", before8.length === 1 && JSON.stringify(before8) === JSON.stringify(after8), JSON.stringify({ before: before8.length, after: after8.length }));

    // ---- e9 ----------------------------------------------------------------------
    const pa = await post(payload(linesWith(WORDS[9], 8)));
    const pb = await post(payload(linesWith(WORDS[9], 9)));
    const ra = String(pa.json.recordingId);
    const rb = String(pb.json.recordingId);
    await runToEnd([ra, rb]).catch((e) => check("e9 the jobs settle", false, firstLine(e)));
    const aEmbed = (await jobsOf(ra)).find((j) => j.kind === "embed_lines");
    const bExtract = (await jobsOf(rb)).find((j) => j.kind === "extract");
    check(
      "e9 the second upload's extract starts before the first upload's embed_lines",
      !!aEmbed?.started && !!bExtract?.started && bExtract.started < aEmbed.started,
      JSON.stringify({ firstEmbedStarted: aEmbed?.started, secondExtractStarted: bExtract?.started }),
    );

    // ---- e10 ---------------------------------------------------------------------
    const cb = await addCall(linesWith("marshlight", 10));
    const list1 = await backlog([]);
    check("e10 embed-backlog lists a call with segments and no windows or job (exit 0)", list1.code === 0 && list1.stdout.includes(cb.id), `exit ${list1.code}: ${(list1.stdout + list1.stderr).slice(0, 300)}`);
    check("e10 it doesn't list a call that already has windows", list1.code === 0 && !list1.stdout.includes(c21.id), `exit ${list1.code}`);
    const queue = await backlog(["--queue"]);
    const cbJobs = (await jobsOf(cb.id)).filter((j) => j.kind === "embed_lines");
    check("e10 --queue queues exactly one embed_lines job for it (exit 0)", queue.code === 0 && cbJobs.length === 1 && cbJobs[0].state === "queued", `exit ${queue.code}: ${JSON.stringify(cbJobs)}`);
    const list2 = await backlog([]);
    check("e10 a second run no longer lists it", list2.code === 0 && !list2.stdout.includes(cb.id), `exit ${list2.code}: ${list2.stdout.slice(0, 200)}`);

    // ---- e5 ----------------------------------------------------------------------
    const cols = hasTable
      ? (await pool.query<{ c: string; t: string }>(`select column_name as c, udt_name as t from information_schema.columns where table_schema = 'public' and table_name = 'transcript_windows' order by 1`)).rows
      : [];
    check(
      "e5 transcript_windows has no text column (varchar only for the model and the rule)",
      cols.length > 0 && !cols.some((x) => x.t === "text") && cols.filter((x) => x.t === "varchar").map((x) => x.c).sort().join(",") === "embedding_model,window_rule",
      JSON.stringify(cols),
    );
    const rowsText = hasTable
      ? (await pool.query<{ j: string }>(`select coalesce(json_agg(row_to_json(w))::text, '') as j from (select id, account_id, recording_id, transcript_id, first_segment, last_segment, embedding_model, window_rule, created_at from transcript_windows where account_id = $1) w`, [fx.accountId])).rows[0].j.toLowerCase()
      : "";
    check("e5 control: the account has window rows", rowsText.length > 2);
    check("e5 no row holds a word of a line", WORDS.every((w) => !rowsText.includes(w)));

    // ---- e11 ---------------------------------------------------------------------
    const all = logged.join("").toLowerCase();
    const leaked = [...WORDS, "marshlight", "robin ashgrove", "tamsin vell"].filter((w) => all.includes(w));
    check("e11 no line written by the server, worker or CLI holds a word of a line or a name", leaked.length === 0, `leaked: ${leaked.join(", ")}`);
    check("e11 control: those words reached Voyage", WORDS.slice(0, 3).every((w) => voyage.requests.some((r) => r.input.some((t) => t.includes(w)))));
    check("e11 control: the capture saw the worker's own lines", logged.some((l) => l.includes("jobs: ")), String(logged.length));
  } finally {
    const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        failures++;
        say(`${WHO}: cleanup step "${what}" failed: ${firstLine(e)}`);
      }
    };
    await attempt("stop the workers", () => Promise.all(workers.map((w) => w.stop())));
    await attempt("close the server", async () => {
      server.close();
    });
    await attempt("empty the jobs table (the backlog may have queued scratch's demo calls)", () => pool.query("delete from jobs"));
    await attempt("drop the run's account", () => dropAccount(fx));
    await attempt("end the pool", () => endPool());
  }
  say(failures === 0 ? `\n${WHO}: all passed` : `\n${WHO}: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  say(`${WHO}: crashed: ${err instanceof Error ? (err.stack ?? err.message).split("\n").slice(0, 4).join(" | ") : String(err)}`);
  process.exit(1);
});
