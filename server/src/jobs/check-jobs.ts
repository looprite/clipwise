// Check for the jobs table, the enqueue and the worker (SAA-227 parts D and E).
// Real code and the real database throughout. The stand-ins are the two paid
// services (extract/stub-model.ts: the Anthropic SDK on a stub fetch, a stub
// embedder) and the request's sign-in (a middleware that sets the access context
// the capture-token guard would; who may call is check-access's business).
//
// Enqueue
//   a0  a first POST /captures stores the capture and queues one extract job
//   b   a repeat POST makes no job
//   c   a late identity answer that names a speaker, on a complete recording,
//       queues a re-extract job, which runs; a second one finds the names already
//       in the promoted run and calls nothing (c-skip)
//   c2  a late answer while the first extract job is queued / running / failed:
//       the enqueue decision (c2), then the end state with the worker running
//         c2q  queued: the job reads the name when it runs
//         c2r  running, caught by runExtraction's own end-of-run check: the run is
//              redone with the name, both run ids are recorded, the first run's
//              rows are gone, the re-extract finds nothing to do
//         c2s  running, but promoted before the answer landed: the re-extract
//              redoes it with the name
// Calendar match (SAA-227 part F). Members X and Y have calendars connected, Z
// has none; Google is answered in this process, by which member's token arrives
//   m1  Z's capture queues no match job; X's queues one beside extract
//   m2  X's match uses X's connection only: Y's token is never sent, and the
//       title and invitees are X's event's
//   m3  X's capture: match and extract both run to done, the recording ready
//   bk  `match-backlog` (src/jobs/cli.ts) lists only a capture made before its
//       owner connected, queues one match job for it with --queue, and a second
//       run queues nothing new
// Worker
//   a   queued, running, done; the recording ready with its current run; no null
//       embedding in it
//   g   a resumed job (its worker died) on a complete recording: zero Anthropic
//       calls
//   h   a Voyage failure leaves null embeddings; the embedding step fills them
//       before done
//   i   three Anthropic failures: failed, attempts 3, no call content in
//       last_error, recording pending
//   j   no ANTHROPIC_API_KEY: failed without using an attempt
//   dur capture.tracks of every shape: the promotion reads a duration or ignores it,
//       and never fails the job
//   d   a job whose lease was taken away cannot promote (renewal off), and with
//       renewal on stands down at once
//   k   a database that stays down is asked once per backoff step, and the steps
//       start again after a success
//   f   SIGTERM to a real server process (src/index.ts, spawned) while its worker
//       is inside a model call that never answers: exit 0 inside the 10 s drain
//       cap, the job queued again with its attempts unchanged and no lease, no
//       rows left; then it runs to done on one attempt
//   e   SIGKILL to a real server process after its run has written moments and
//       while it waits on the collapse call: once the dead lease runs out, a worker
//       started here (start(): the boot path) claims the job, deletes the killed
//       run's rows, and promotes exactly one run; the killed attempt is counted
//       (only a shutdown or a lost lease gives one back), so attempts is 2
// CLI (src/jobs/cli.ts, run as its own process)
//   r   a job failed on three attempts is put back by `retry` with attempts 0 and
//       runs to done on one attempt; `retry` refuses a running job, an unknown id
//       and a malformed one (exit 1, the row untouched); `list` shows the jobs by
//       id and state and holds the planted phrase nowhere, though the recordings'
//       moments carry it
// Throughout: no log line holds the planted phrase (the spawned server's lines
// included).
//
// CLIPWISE_CHECK_CONTROL=<case,case> runs only those cases (scratch-db.sh passes
// the variable through). A control is a case run against code with its protection
// taken out.
//
//   scripts/scratch-db.sh run check-jobs

import express from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { makeStubEmbedder, makeStubModel, waitFor } from "../extract/stub-model.js";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { capturesPost } from "../routes/captures.js";
import { encrypt } from "../lib/crypto.js";
import { errorHandler } from "../lib/http.js";
import { JobWorker, type WorkerOptions } from "./worker.js";

const only = (process.env.CLIPWISE_CHECK_CONTROL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const wanted = (...names: string[]): boolean => only.length === 0 || names.some((n) => only.includes(n));

// The check's own lines bypass the capture below; everything the code under test
// prints goes into it and is scanned at the end.
const realWrite = process.stdout.write.bind(process.stdout);
const say = (s: string): void => {
  realWrite(`${s}\n`);
};
const captured: string[] = [];
// Every "lease lost" the worker logs, with what was true when it was logged: had
// that job's "running→done" line already been logged, and what state did the job
// row have in the database a moment after.
const leaseLost: { jobId: string; doneLineBefore: boolean; dbState: string | null }[] = [];
const leaseLostLookups: Promise<void>[] = [];
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  console[m] = (...args: unknown[]): void => {
    const line = args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
    const jobId = /^jobs: ([0-9a-f-]{36}) /.exec(line)?.[1];
    if (jobId && line.includes("lease lost")) {
      const ev = { jobId, doneLineBefore: captured.some((l) => l.startsWith(`jobs: ${jobId} `) && l.includes("running→done")), dbState: null as string | null };
      leaseLost.push(ev);
      leaseLostLookups.push(
        pool
          .query("select state from jobs where id = $1", [jobId])
          .then((r) => {
            ev.dbState = r.rows[0]?.state ?? "(row gone)";
          })
          .catch((e: unknown) => {
            ev.dbState = "(lookup failed)";
            backgroundErrors.push(`lease-lost lookup: ${firstLine(e)}`);
          }),
      );
    }
    captured.push(line);
    realWrite(`    | ${line}\n`);
  };
}

// An error nobody awaited (a poll or a timer callback hitting a database error)
// must not kill the process: that skips the cleanup below and leaves the run's
// account and jobs behind. It is recorded, the run goes on, and it fails the run
// at the end.
const backgroundErrors: string[] = [];
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
process.on("unhandledRejection", (e) => {
  backgroundErrors.push(`unhandled rejection: ${firstLine(e)}`);
});
process.on("uncaughtException", (e) => {
  backgroundErrors.push(`uncaught exception: ${firstLine(e)}`);
});

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  say(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

const PHRASE = "PURPLE-ELEPHANT-4417";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string };
const SEGS: Seg[] = [
  { track: "me", startMs: 0, endMs: 1500, text: "hello there" },
  { track: "them", startMs: 1600, endMs: 3000, text: "hi" },
  { track: "me", startMs: 3100, endMs: 4000, text: "shall we begin" },
  { track: "them", startMs: 4100, endMs: 5000, text: "yes" },
];

// The shapes the recorder sends (routes/captures.ts has the references): the
// manifest's tracks, an array with each track's length, and the classifier's.
const TRACKS = [
  { track: "system", file: "system-x.f32le.pcm", encoding: "f32le", container: "raw", channels: 1, sample_rate: 48000, sample_rate_source: "systemtap_reported_tap_format", device_name: "Out", device_uid: "out-uid", duration_s: 5.0 },
  { track: "mic", file: "mic-x.wav", encoding: "f32le", container: "wav", sample_rate: 48000, sample_rate_source: "wav_fmt_chunk_readback", device_name: "In", device_uid: "in-uid", duration_s: 5.2 },
];
const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 5, gaps: [], note: "check" });

function payload(o: { id?: string; identity?: unknown; segments?: Seg[] } = {}): Record<string, unknown> {
  const segments = o.segments ?? SEGS;
  const id = o.id ?? randomUUID().toUpperCase();
  return {
    captureId: id,
    startedAt: "2026-10-10T10:00:00.000Z",
    stem: `check-jobs-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: segments.reduce((n, x) => n + x.text.length, 0), countedFrom: "check-jobs" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { tracks: TRACKS, permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...(o.identity ? { identity: o.identity } : {}),
  };
}

const answer = (at: string, self: string | null, guests: string[] = []) => ({
  answered_at: at,
  self: self === null ? null : { name: self, source: "check" },
  guests: guests.map((name) => ({ name })),
  scope: "work",
});

async function main(): Promise<void> {
  await refuseUnlessScratch("check-jobs");
  // If the run is still going after STALL_MS, say where the pool stands and what
  // the database sees from a fresh connection (the pool may be the thing that is
  // full), then stop. Nothing here carries call content: pg_stat_activity is read
  // for pid, state, wait event, age and the first 70 characters of our own SQL.
  // Cleared as soon as the checks are over, before teardown.
  const STALL_MS = 120_000;
  const stall = setTimeout(async () => {
    say(`STALL after ${STALL_MS / 1000} s: pool total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await c.connect();
      const r = await c.query(
        `select pid, state, wait_event_type, wait_event, round(extract(epoch from now() - query_start)::numeric, 1) as age_s, left(query, 70) as q
         from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by query_start`,
      );
      say(`STALL pg_stat_activity: ${r.rows.length} row(s)`);
      for (const row of r.rows) say(`STALL   ${JSON.stringify(row)}`);
    } catch (e) {
      say(`STALL could not read pg_stat_activity: ${firstLine(e)}`);
    } finally {
      process.exit(2);
    }
  }, STALL_MS);
  stall.unref();
  process.env.ANTHROPIC_API_KEY = "stub-key";
  // The worker claims any job in the table, so a run starts from an empty one: a
  // job left by an earlier run that crashed would otherwise be run by this one.
  // (refuseUnlessScratch has already refused anything but the scratch database.)
  const leftovers = await pool.query("delete from jobs");
  say(`check-jobs: emptied the jobs table before starting (${leftovers.rowCount} leftover row(s))`);
  const fx: Fixture = await makeAccount("check-jobs");

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    // x-check-member: the match cases post as another member of the account.
    const memberId = typeof req.headers["x-check-member"] === "string" ? req.headers["x-check-member"] : fx.memberId;
    req.access = { accountId: fx.accountId, memberId, role: "member", authUserId: "check", email: "check@clipwise.test", scope: ["clipwise:capture"] };
    next();
  });
  app.post("/captures", capturesPost);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, asMember?: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(asMember ? { "x-check-member": asMember } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const jobsOf = (recordingId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.recordingId, recordingId)).orderBy(schema.jobs.createdAt);
  const speakersOf = (recordingId: string) => db.select({ label: schema.speakers.label, name: schema.speakers.displayName }).from(schema.speakers).where(eq(schema.speakers.recordingId, recordingId));
  const clearJobs = async (): Promise<void> => {
    await db.delete(schema.jobs).where(eq(schema.jobs.accountId, fx.accountId));
  };
  const setState = (recordingId: string, state: string) => db.update(schema.jobs).set({ state }).where(eq(schema.jobs.recordingId, recordingId));
  const recOf = async (recordingId: string): Promise<{ status: string; run: string | null; fp: string | null }> => {
    const r = await pool.query(
      `select status, metadata->>'current_extraction_run' as run, metadata->>'extraction_speaker_fingerprint' as fp from recordings where id = $1`,
      [recordingId],
    );
    return r.rows[0];
  };
  const momentsOf = async (recordingId: string): Promise<{ run: string; noEmb: boolean; collapsed: boolean }[]> => {
    const r = await pool.query(
      `select metadata->>'extraction_run' as run, (embedding is null) as "noEmb", (metadata->>'collapsed_into') is not null as collapsed from moments where recording_id = $1`,
      [recordingId],
    );
    return r.rows;
  };
  const settle = async (recordingId: string, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const js = await jobsOf(recordingId);
      if (js.length > 0 && js.every((j) => j.state === "done" || j.state === "failed")) return js;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for the jobs of ${recordingId}: ${JSON.stringify(js.map((j) => ({ kind: j.kind, state: j.state, attempts: j.attempts, hasLease: j.leaseToken !== null, runIds: j.runIds.length, errorClass: j.errorClass, lastError: j.lastError })))}`);
      await sleep(25);
    }
  };
  const fresh = async (): Promise<{ p: Record<string, unknown>; recordingId: string }> => {
    const p = payload();
    return { p, recordingId: String((await post(p)).json.recordingId) };
  };
  const model = (o: Partial<Parameters<typeof makeStubModel>[0]> = {}) => makeStubModel({ segmentCount: SEGS.length, phrase: PHRASE, ...o });
  const workers: JobWorker[] = [];
  const worker = (stub: ReturnType<typeof makeStubModel>, emb: ReturnType<typeof makeStubEmbedder>, o: WorkerOptions = {}) => {
    const w = new JobWorker({ anthropicFetch: stub.fetch, embedder: emb, renewMs: 200, leaseMs: 10_000, backoffMs: [40, 40], ...o });
    workers.push(w);
    return w;
  };
  const runToEnd = async (w: JobWorker, recordingId: string) => {
    w.wake();
    const jobs = await settle(recordingId);
    await w.stop();
    return jobs;
  };
  const named = (body: string): boolean => body.includes("Host Name:");
  const children: ChildProcess[] = [];

  try {
    // ---- enqueue ------------------------------------------------------------
    if (wanted("a0", "b")) {
      const p = payload();
      const first = await post(p);
      const recordingId = String(first.json.recordingId);
      const jobs1 = await jobsOf(recordingId);
      check("a0 the first POST is 201 and queues one extract job for the recording", first.status === 201 && jobs1.length === 1 && jobs1[0].kind === "extract" && jobs1[0].state === "queued" && jobs1[0].attempts === 0 && jobs1[0].accountId === fx.accountId, JSON.stringify({ status: first.status, jobs: jobs1.map((j) => [j.kind, j.state]) }));
      const repeat = await post(p);
      const jobs2 = await jobsOf(recordingId);
      check("b a repeat POST is 200 created:false and makes no job", repeat.status === 200 && repeat.json.created === false && jobs2.length === 1 && jobs2[0].id === jobs1[0].id, JSON.stringify({ status: repeat.status, jobs: jobs2.length }));
      const again = await Promise.all([post(p), post(p), post(p)]);
      check("b three concurrent repeats make no job either", again.every((r) => r.status === 200) && (await jobsOf(recordingId)).length === 1);
      const conflict = await post({ ...p, segments: [{ ...SEGS[0], text: "something else" }], sourceFidelity: { declaredTurnCount: 1, declaredBodyChars: 14, countedFrom: "x" } });
      check("b a conflicting repeat is 409 and makes no job", conflict.status === 409 && (await jobsOf(recordingId)).length === 1, String(conflict.status));
    }

    if (wanted("c2")) {
      const reCount = async (recordingId: string): Promise<number> => (await jobsOf(recordingId)).filter((j) => j.kind === "re_extract").length;
      const mk = async (state: string | null) => {
        const r = await fresh();
        if (state) await setState(r.recordingId, state);
        return r;
      };
      const queued = await mk(null);
      const rq = await post({ ...queued.p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      check("c2 first job queued: the answer is applied (name on the speaker) and no re_extract is queued", rq.json.identityApplied === true && (await reCount(queued.recordingId)) === 0 && (await speakersOf(queued.recordingId)).some((s) => s.name === "Host Name"), JSON.stringify(await jobsOf(queued.recordingId)));
      const running = await mk("running");
      const rr = await post({ ...running.p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      const rjobs = await jobsOf(running.recordingId);
      check("c2 first job running: the answer queues one re_extract, behind the running extract", rr.json.identityApplied === true && rjobs.length === 2 && rjobs.some((j) => j.kind === "extract" && j.state === "running") && rjobs.some((j) => j.kind === "re_extract" && j.state === "queued"), JSON.stringify(rjobs.map((j) => [j.kind, j.state])));
      const failed = await mk("failed");
      const rf = await post({ ...failed.p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      check("c2 first job failed: the answer is applied and nothing is queued", rf.json.identityApplied === true && (await reCount(failed.recordingId)) === 0);
      const noNames = await mk("running");
      const rn = await post({ ...noNames.p, identity: answer("2026-10-10T10:05:00Z", null, ["A", "B"]) });
      check("c2 an answer that writes no speaker name (no host name, two guests) queues nothing even while running", rn.json.identityApplied === true && (await reCount(noNames.recordingId)) === 0, JSON.stringify(await speakersOf(noNames.recordingId)));
    }

    // src/jobs/cli.ts as its own process (cases r and bk). Its lines go into the
    // capture, so the end-of-run phrase scan covers them.
    const cli = (...args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
      new Promise((done) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/jobs/cli.ts", ...args], {
          cwd: resolve(import.meta.dirname, "..", ".."),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let out = "";
        let err = "";
        child.stdout!.on("data", (c) => (out += c));
        child.stderr!.on("data", (c) => (err += c));
        child.once("close", (code) => {
          for (const line of `${out}${err}`.split("\n").filter(Boolean)) {
            captured.push(line);
            realWrite(`    cli| ${line}\n`);
          }
          done({ code, out, err });
        });
      });

    // ---- calendar match ----------------------------------------------------------
    if (wanted("m1", "m2", "m3")) {
      await clearJobs();
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
      const memberOf = async (who: string): Promise<string> => {
        const [m] = await db
          .insert(schema.accountMembers)
          .values({ accountId: fx.accountId, email: `${who}-${fx.tag}@clipwise.test`, role: "member", joinedAt: new Date() })
          .returning({ id: schema.accountMembers.id });
        return m.id;
      };
      const X = fx.memberId;
      const Y = await memberOf("check-jobs-y");
      const Z = await memberOf("check-jobs-z");
      const tokenOf = (who: string) => `check-jobs-${who}-${fx.tag}-access`;
      const connect = (memberId: string, who: string) =>
        db.insert(schema.calendarConnections).values({
          accountId: fx.accountId,
          memberId,
          calendarEmail: `${who}-${fx.tag}@clipwise.test`,
          accessToken: encrypt(tokenOf(who)),
          refreshToken: encrypt(`check-jobs-${who}-refresh`),
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          scope: "https://www.googleapis.com/auth/calendar.readonly",
          searchedCalendarIds: [`${who}-cal-${fx.tag}@clipwise.test`],
        });
      await connect(X, "x");
      await connect(Y, "y");

      // Each member's calendar holds one event 30 s after the payload's start, with
      // its own title and invitee. Which token arrived is recorded.
      const tokensSeen: string[] = [];
      const eventFor: Record<string, { title: string; invitee: string }> = {
        [tokenOf("x")]: { title: "X's meeting", invitee: `guest-x-${fx.tag}@clipwise.test` },
        [tokenOf("y")]: { title: "Y's meeting", invitee: `guest-y-${fx.tag}@clipwise.test` },
      };
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/")) {
          const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
          tokensSeen.push(token);
          const ev = eventFor[token];
          const items = ev
            ? [{ id: `evt-${token.slice(11, 12)}`, summary: ev.title, start: { dateTime: "2026-10-10T10:00:30.000Z" }, attendees: [{ email: ev.invitee, displayName: null, responseStatus: "accepted" }] }]
            : [];
          return Response.json({ items });
        }
        return realFetch(input, init);
      }) as typeof fetch;
      try {
        const kindsOf = async (recordingId: string) => (await jobsOf(recordingId)).map((j) => j.kind).sort();
        const capZ = String((await post(payload(), Z)).json.recordingId);
        const capX = String((await post(payload(), X)).json.recordingId);
        const kz = await kindsOf(capZ);
        const kx = await kindsOf(capX);
        check("m1 an owner with no calendar connected gets no match job, though other members have one", JSON.stringify(kz) === JSON.stringify(["extract"]), JSON.stringify(kz));
        check("m1 an owner with a calendar connected gets a match job beside extract (the control)", JSON.stringify(kx) === JSON.stringify(["extract", "match"]), JSON.stringify(kx));

        await db.delete(schema.jobs).where(eq(schema.jobs.recordingId, capZ));
        const jobs = await runToEnd(worker(model(), makeStubEmbedder()), capX);
        const rec = (await pool.query("select status, title from recordings where id = $1", [capX])).rows[0] as { status: string; title: string | null };
        const inv = (await pool.query("select email from invitees where recording_id = $1 order by email", [capX])).rows.map((r) => r.email as string);
        const uniqueTokens = [...new Set(tokensSeen)];

        check(
          "m2 the match uses the owner's connection only: X's token sent, Y's never, and the title and invitee are X's event's",
          uniqueTokens.length === 1 && uniqueTokens[0] === tokenOf("x") && rec.title === "X's meeting" && JSON.stringify(inv) === JSON.stringify([eventFor[tokenOf("x")].invitee]),
          JSON.stringify({ tokens: uniqueTokens.map((t) => (t === tokenOf("x") ? "X's" : t === tokenOf("y") ? "Y's" : "other")), title: rec.title, invitees: inv.length }),
        );
        check(
          "m3 match and extract both run to done for one capture, on one attempt each, and the recording is ready",
          jobs.length === 2 && jobs.every((j) => j.state === "done" && j.attempts === 1) && JSON.stringify(jobs.map((j) => j.kind).sort()) === JSON.stringify(["extract", "match"]) && rec.status === "ready",
          JSON.stringify({ jobs: jobs.map((j) => [j.kind, j.state, j.attempts, j.errorClass]), status: rec.status }),
        );
      } finally {
        globalThis.fetch = realFetch;
        // X is the member every other case posts as: with X still connected, every
        // later capture would queue a match job and send it to the real Google.
        await db.delete(schema.calendarConnections).where(eq(schema.calendarConnections.accountId, fx.accountId));
        await clearJobs();
      }
    }

    // ---- bk: the match backlog (SAA-227 decisions 12 and 23) ----------------------
    // Four recordings in this account: one captured before its owner connected (the
    // only eligible one), one whose owner never connects, one captured after its
    // owner connected (it already has a match job), and one from before the
    // cut-over (it carries a transcript_source_path), whose owner is connected.
    if (wanted("bk")) {
      await clearJobs();
      const member = async (who: string): Promise<string> => {
        const [m] = await db
          .insert(schema.accountMembers)
          .values({ accountId: fx.accountId, email: `${who}-${fx.tag}@clipwise.test`, role: "member", joinedAt: new Date() })
          .returning({ id: schema.accountMembers.id });
        return m.id;
      };
      const connect = (memberId: string, who: string) =>
        db.insert(schema.calendarConnections).values({
          accountId: fx.accountId,
          memberId,
          calendarEmail: `bk-${who}-${fx.tag}@clipwise.test`,
          accessToken: "check-not-used",
          refreshToken: "check-not-used",
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          searchedCalendarIds: [],
        });
      try {
        const late = await member("check-jobs-bk-late");
        const never = await member("check-jobs-bk-never");
        const early = await member("check-jobs-bk-early");
        await connect(early, "early");
        const recLate = String((await post(payload(), late)).json.recordingId);
        const recNever = String((await post(payload(), never)).json.recordingId);
        const recEarly = String((await post(payload(), early)).json.recordingId);
        const recPre = await makeRecording(fx, { segments: 1 });
        await db.update(schema.recordings).set({ ownerMemberId: late, metadata: { transcript_source_path: "/check/transcript-pre.json" } }).where(eq(schema.recordings.id, recPre));
        await connect(late, "late");

        const names: Record<string, string> = { [recLate]: "late", [recNever]: "never", [recEarly]: "early", [recPre]: "pre-cutover" };
        const listedIds = (out: string): string[] => [...out.matchAll(/^ {2}([0-9a-f-]{36}) owner=/gm)].map((m) => m[1]);
        const ours = (out: string): string[] => listedIds(out).filter((id) => id in names).map((id) => names[id]);
        const matchJobs = async (rec: string) => (await jobsOf(rec)).filter((j) => j.kind === "match");
        const counts = async () => ({ late: (await matchJobs(recLate)).length, never: (await matchJobs(recNever)).length, early: (await matchJobs(recEarly)).length, pre: (await matchJobs(recPre)).length });

        const dry = await cli("match-backlog");
        const afterDry = await counts();
        check(
          "bk the listing names only the recording captured before its owner connected; not the never-connected, the already-matched or the pre-cut-over one; and it queues nothing",
          dry.code === 0 && JSON.stringify(ours(dry.out)) === JSON.stringify(["late"]) && JSON.stringify(afterDry) === JSON.stringify({ late: 0, never: 0, early: 1, pre: 0 }),
          JSON.stringify({ code: dry.code, listed: ours(dry.out), matchJobs: afterDry, err: dry.err.trim() }),
        );

        const first = await cli("match-backlog", "--queue");
        const afterFirst = await counts();
        const lateJob = (await matchJobs(recLate))[0];
        check(
          "bk --queue queues one match job for that recording and for no other of the four, and says how many it queued",
          first.code === 0 && first.out.includes(`queued ${listedIds(first.out).length} match job(s)`) && JSON.stringify(afterFirst) === JSON.stringify({ late: 1, never: 0, early: 1, pre: 0 }) && lateJob?.state === "queued",
          JSON.stringify({ code: first.code, listed: ours(first.out), matchJobs: afterFirst, err: first.err.trim() }),
        );

        const second = await cli("match-backlog", "--queue");
        const afterSecond = await counts();
        check(
          "bk a second run lists none of the four and queues nothing new",
          second.code === 0 && ours(second.out).length === 0 && second.out.includes(`queued ${listedIds(second.out).length} match job(s)`) && JSON.stringify(afterSecond) === JSON.stringify(afterFirst),
          JSON.stringify({ code: second.code, listed: ours(second.out), matchJobs: afterSecond, err: second.err.trim() }),
        );
      } finally {
        await db.delete(schema.calendarConnections).where(eq(schema.calendarConnections.accountId, fx.accountId));
        await clearJobs();
      }
    }

    // ---- a, then c and c-skip on its recording, then g ------------------------
    let done: { p: Record<string, unknown>; recordingId: string } | null = null;
    if (wanted("a", "c", "c-skip", "g")) {
      await clearJobs();
      const stub = model({ onCall: async ({ n, signal }) => { if (n === 1) await waitFor(150, signal); } });
      const emb = makeStubEmbedder();
      const { p, recordingId } = await fresh();
      const states: string[] = [(await jobsOf(recordingId))[0].state];
      // Watches the job's state from the side, one query at a time (each is awaited
      // before the next is sent, as settle() does): an interval that fires whether or
      // not the last query has come back puts as many queries in flight as the round
      // trip allows, and filled the 10-connection pool in the runs that stalled.
      let watching = true;
      const watcher = (async () => {
        while (watching) {
          try {
            const s = (await jobsOf(recordingId))[0]?.state;
            if (s && states[states.length - 1] !== s) states.push(s);
          } catch (e) {
            backgroundErrors.push(`state watcher: ${firstLine(e)}`);
          }
          await sleep(15);
        }
      })();
      const w = worker(stub, emb);
      let jobs;
      try {
        jobs = await runToEnd(w, recordingId);
        await sleep(40);
      } finally {
        watching = false;
        await watcher;
      }
      const rec = await recOf(recordingId);
      const ms = await momentsOf(recordingId);
      const cur = ms.filter((m) => m.run === rec.run && !m.collapsed);
      check("a the job goes queued, running, done", JSON.stringify(states) === JSON.stringify(["queued", "running", "done"]) && jobs.length === 1 && jobs[0].state === "done" && jobs[0].attempts === 1, JSON.stringify({ states, jobs: jobs.map((j) => [j.state, j.attempts]) }));
      check("a the recording is ready with its current run set, and it is the job's run", rec.status === "ready" && !!rec.run && jobs[0].runIds.length === 1 && jobs[0].runIds[0] === rec.run, JSON.stringify({ rec, runIds: jobs[0].runIds }));
      check("a the current run has moments and none lacks an embedding", cur.length > 0 && cur.every((m) => !m.noEmb), JSON.stringify({ current: cur.length, withoutEmbedding: cur.filter((m) => m.noEmb).length }));
      check("a one pass 1, two pass 2 and one collapse call, and no lease or error left on the row", JSON.stringify(stub.calls) === JSON.stringify(["pass1", "pass2", "pass2", "collapse"]) && jobs[0].leaseToken === null && jobs[0].lastError === null && jobs[0].errorClass === null, JSON.stringify({ calls: stub.calls }));
      done = { p, recordingId };
    }

    if (done && wanted("c")) {
      const before = await recOf(done.recordingId);
      const late = await post({ ...done.p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      const re = (await jobsOf(done.recordingId)).filter((j) => j.kind === "re_extract");
      check("c a late answer naming the host on a complete recording is 200 identityApplied and queues one re_extract", late.status === 200 && late.json.identityApplied === true && re.length === 1 && re[0].state === "queued", JSON.stringify({ status: late.status, jobs: re.map((j) => j.state) }));
      check("c the name is on the speaker row", (await speakersOf(done.recordingId)).some((s) => s.label === "me" && s.name === "Host Name"));
      const sameAgain = await post({ ...done.p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      check("c the same answer again applies nothing and queues nothing", sameAgain.json.identityApplied === false && (await jobsOf(done.recordingId)).filter((j) => j.kind === "re_extract").length === 1);
      const stub = model();
      const jobs = await runToEnd(worker(stub, makeStubEmbedder()), done.recordingId);
      const after = await recOf(done.recordingId);
      const reJob = jobs.find((j) => j.kind === "re_extract");
      const distinctRuns = new Set((await momentsOf(done.recordingId)).map((m) => m.run));
      check("c the re_extract runs: done, a new current run, built with the name (pass 1 saw 'Host Name:'), the earlier run's moments untouched", reJob?.state === "done" && after.run !== before.run && !!after.run && stub.calls.filter((k) => k === "pass1").length === 1 && named(stub.bodies[0]) && distinctRuns.size === 2, JSON.stringify({ reJob: reJob?.state, runChanged: after.run !== before.run, distinctRuns: distinctRuns.size }));
      check("c the promoted run records the speaker fingerprint it was built on, different from before", !!after.fp && after.fp !== before.fp);
    }

    if (done && wanted("c-skip")) {
      const stub = model();
      const emb = makeStubEmbedder();
      await db.insert(schema.jobs).values({ accountId: fx.accountId, recordingId: done.recordingId, kind: "re_extract" });
      const jobs = await runToEnd(worker(stub, emb), done.recordingId);
      check("c-skip a re_extract whose promoted run already holds these names calls nothing", jobs.filter((j) => j.kind === "re_extract" && j.state === "done").length >= 1 && stub.calls.length === 0 && emb.calls === 0, JSON.stringify({ calls: stub.calls, jobs: jobs.map((j) => [j.kind, j.state]) }));
    }

    if (done && wanted("g")) {
      await clearJobs();
      const stub = model();
      const emb = makeStubEmbedder();
      // A job its worker died holding: running, the lease long out, one attempt used.
      await pool.query(
        `insert into jobs (account_id, recording_id, kind, state, attempts, lease_token, lease_expires_at, started_at)
         values ($1, $2, 'extract', 'running', 1, gen_random_uuid(), now() - interval '5 minutes', now() - interval '6 minutes')`,
        [fx.accountId, done.recordingId],
      );
      const jobs = await runToEnd(worker(stub, emb), done.recordingId);
      check("g a resumed job on a complete recording is taken over and finishes with zero Anthropic and zero embedding calls", jobs.length === 1 && jobs[0].state === "done" && jobs[0].attempts === 2 && stub.calls.length === 0 && emb.calls === 0, JSON.stringify({ job: jobs.map((j) => [j.state, j.attempts]), calls: stub.calls.length, embedderCalls: emb.calls }));
    }

    // ---- h ---------------------------------------------------------------------
    if (wanted("h")) {
      await clearJobs();
      const stub = model();
      let nullsBeforeStep = -1;
      const { recordingId } = await fresh();
      const emb = makeStubEmbedder({
        failFirst: 1,
        onCall: async (n) => {
          if (n === 2) nullsBeforeStep = (await momentsOf(recordingId)).filter((m) => m.noEmb && !m.collapsed).length;
        },
      });
      const jobs = await runToEnd(worker(stub, emb), recordingId);
      const rec = await recOf(recordingId);
      const cur = (await momentsOf(recordingId)).filter((m) => m.run === rec.run && !m.collapsed);
      check("h a Voyage failure leaves null embeddings (the failed call), and the embedding step fills every one before done", nullsBeforeStep > 0 && cur.length > 0 && cur.every((m) => !m.noEmb) && jobs[0].state === "done" && emb.calls >= 2, JSON.stringify({ nullsBeforeStep, currentWithoutEmbedding: cur.filter((m) => m.noEmb).length, embedderCalls: emb.calls, job: jobs[0].state }));
    }

    // ---- i ---------------------------------------------------------------------
    if (wanted("i")) {
      await clearJobs();
      const stub = model({ failStatus: 400 });
      const { recordingId } = await fresh();
      const jobs = await runToEnd(worker(stub, makeStubEmbedder()), recordingId);
      const rec = await recOf(recordingId);
      check("i three Anthropic failures end the job failed with attempts 3, an error class, and a last_error that holds none of the API's words", jobs[0].state === "failed" && jobs[0].attempts === 3 && jobs[0].errorClass === "BadRequestError" && !!jobs[0].lastError && !jobs[0].lastError.includes(PHRASE) && !jobs[0].lastError.includes("quoted back"), JSON.stringify({ state: jobs[0].state, attempts: jobs[0].attempts, errorClass: jobs[0].errorClass, lastError: jobs[0].lastError }));
      check("i the recording stays pending, with no moments and no current run", rec.status === "pending" && rec.run === null && (await momentsOf(recordingId)).length === 0, JSON.stringify(rec));
      check("i each attempt called Anthropic once (a 400 is not retried by the SDK)", stub.calls.length === 3, String(stub.calls.length));
    }

    // ---- j ---------------------------------------------------------------------
    if (wanted("j")) {
      await clearJobs();
      const stub = model();
      const { recordingId } = await fresh();
      delete process.env.ANTHROPIC_API_KEY;
      let jobs;
      try {
        jobs = await runToEnd(worker(stub, makeStubEmbedder()), recordingId);
      } finally {
        process.env.ANTHROPIC_API_KEY = "stub-key";
      }
      check("j a missing ANTHROPIC_API_KEY fails the job without using an attempt, with no Anthropic call", jobs[0].state === "failed" && jobs[0].attempts === 0 && jobs[0].errorClass === "MissingApiKeyError" && stub.calls.length === 0, JSON.stringify({ state: jobs[0].state, attempts: jobs[0].attempts, errorClass: jobs[0].errorClass, calls: stub.calls.length }));
      check("j the recording stays pending", (await recOf(recordingId)).status === "pending");
    }

    // ---- d ---------------------------------------------------------------------
    if (wanted("d")) {
      // d1: the renewal is off (an hour), so only the fence stands between a worker
      // that does not know it lost the lease and the promotion.
      await clearJobs();
      let jobId = "";
      const steal = async (): Promise<void> => {
        await pool.query("update jobs set lease_token = gen_random_uuid() where id = $1", [jobId]);
      };
      const stub = model({ onCall: async ({ n }) => { if (n === 1) await steal(); } });
      const { recordingId } = await fresh();
      jobId = (await jobsOf(recordingId))[0].id;
      const w = worker(stub, makeStubEmbedder(), { renewMs: 3_600_000 });
      w.wake();
      await sleep(20);
      await w.whenIdle();
      await w.stop();
      const rec = await recOf(recordingId);
      const [job] = await jobsOf(recordingId);
      check("d a job whose lease was taken away runs to the end but cannot promote: the recording is still pending with no current run", rec.status === "pending" && rec.run === null && stub.calls.length === 4, JSON.stringify({ rec, calls: stub.calls.length }));
      check("d and it does not mark the job done: the row still belongs to whoever holds the new token", job.state === "running" && job.leaseToken !== null, JSON.stringify({ state: job.state }));

      // d2: the renewal is on and finds the token gone: the job stands down at once.
      await clearJobs();
      let t0 = 0;
      const stub2 = model({
        onCall: async ({ n, signal }) => {
          if (n === 1) {
            await steal();
            t0 = Date.now();
            await waitFor(5000, signal);
          }
        },
      });
      const r2 = await fresh();
      jobId = (await jobsOf(r2.recordingId))[0].id;
      const w2 = worker(stub2, makeStubEmbedder(), { renewMs: 60 });
      w2.wake();
      await sleep(20);
      await w2.whenIdle();
      const stoodDownAfter = Date.now() - t0;
      await w2.stop();
      const rec2 = await recOf(r2.recordingId);
      check("d with renewal on, the renewal finds the token gone and aborts the in-flight call: no further call, nothing promoted, well inside the call's 5 s", stub2.calls.length === 1 && rec2.status === "pending" && rec2.run === null && stoodDownAfter < 4000, JSON.stringify({ calls: stub2.calls.length, rec: rec2, stoodDownAfterMs: stoodDownAfter }));
    }

    // ---- c2 with the worker -------------------------------------------------------
    if (wanted("c2q", "c2")) {
      await clearJobs();
      const stub = model();
      const { p, recordingId } = await fresh();
      await post({ ...p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      const jobs = await runToEnd(worker(stub, makeStubEmbedder()), recordingId);
      const rec = await recOf(recordingId);
      check("c2q first job queued when the answer lands: it reads the name when it runs, nothing else is queued", jobs.length === 1 && jobs[0].state === "done" && rec.status === "ready" && stub.calls.filter((k) => k === "pass1").length === 1 && named(stub.bodies[0]), JSON.stringify({ jobs: jobs.map((j) => [j.kind, j.state]), pass1Saw: named(stub.bodies[0] ?? "") }));
    }

    if (wanted("c2r", "c2")) {
      await clearJobs();
      let entered = false;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const stub = model({
        onCall: async ({ n }) => {
          if (n === 1) {
            entered = true;
            await gate;
          }
        },
      });
      const { p, recordingId } = await fresh();
      const w = worker(stub, makeStubEmbedder());
      w.wake();
      while (!entered) await sleep(10);
      const mid = (await jobsOf(recordingId))[0];
      await post({ ...p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      const queuedBehind = (await jobsOf(recordingId)).filter((j) => j.kind === "re_extract").length;
      release();
      const jobs = await settle(recordingId);
      await w.stop();
      const rec = await recOf(recordingId);
      const ms = await momentsOf(recordingId);
      const extract = jobs.find((j) => j.kind === "extract")!;
      const reJob = jobs.find((j) => j.kind === "re_extract");
      const pass1 = stub.bodies.filter((_, i) => stub.calls[i] === "pass1");
      check("c2r the first job was running when the answer landed, and a re_extract was queued behind it", mid.state === "running" && queuedBehind === 1);
      check("c2r it ends ready, the current run was built with the name (the redo's pass 1 saw 'Host Name:', the first run's did not)", rec.status === "ready" && pass1.length === 2 && !named(pass1[0]) && named(pass1[1]), JSON.stringify({ pass1Calls: pass1.length, first: named(pass1[0] ?? ""), second: named(pass1[1] ?? "") }));
      check("c2r both runs are recorded on the job (onRunStart passed through the redo), the current one is the second, and the first run's rows are gone", extract.runIds.length === 2 && extract.runIds[1] === rec.run && new Set(ms.map((m) => m.run)).size === 1 && ms[0].run === rec.run, JSON.stringify({ runIds: extract.runIds.length, current: rec.run, distinctRunsInMoments: new Set(ms.map((m) => m.run)).size }));
      check("c2r the re_extract finds the promoted run already built on the name and calls nothing; nothing is left queued or running", reJob?.state === "done" && stub.calls.length === 8 && jobs.every((j) => j.state === "done"), JSON.stringify({ calls: stub.calls.length, jobs: jobs.map((j) => [j.kind, j.state]) }));
    }

    if (wanted("c2s", "c2")) {
      await clearJobs();
      const stub = model();
      const { p, recordingId } = await fresh();
      // The embedding call inside the run fails, so the recording is promoted with
      // null embeddings and the worker's embedding step calls the embedder a
      // second time: by then the recording is complete on the old names and the
      // extract job is still running. The answer lands there.
      const emb = makeStubEmbedder({
        failFirst: 1,
        onCall: async (n) => {
          if (n === 2) await post({ ...p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
        },
      });
      const jobs = await runToEnd(worker(stub, emb), recordingId);
      const rec = await recOf(recordingId);
      const pass1 = stub.bodies.filter((_, i) => stub.calls[i] === "pass1");
      const cur = (await momentsOf(recordingId)).filter((m) => m.run === rec.run && !m.collapsed);
      check("c2s promoted on the old names before the answer landed: the re_extract redoes it, and the current run was built with the name", rec.status === "ready" && pass1.length === 2 && !named(pass1[0]) && named(pass1[1]) && jobs.every((j) => j.state === "done") && jobs.some((j) => j.kind === "re_extract"), JSON.stringify({ pass1Calls: pass1.length, jobs: jobs.map((j) => [j.kind, j.state]) }));
      check("c2s and the new current run has embeddings", cur.length > 0 && cur.every((m) => !m.noEmb));
    }

    // ---- dur: the capture's tracks as the promotion reads them ---------------------
    // POST /captures refuses every shape but the recorder's (check-access case 13),
    // so the others are put on the row directly: the promotion reads defensively
    // all the same, because one that raised would fail the job three times and
    // leave the recording pending for good.
    if (wanted("dur")) {
      const shapes: [string, unknown, number | null][] = [
        ["an array of tracks with duration_s (the recorder's shape)", TRACKS, 5.2],
        ["an object (not an array)", { tap: { verdict: "ok" } }, null],
        ["a string", "tracks", null],
        ["an array with a non-numeric duration_s and a scalar", [{ track: "mic", duration_s: "long" }, 7], null],
        ["an array with one good duration_s among bad ones", [{ duration_s: "x" }, { duration_s: 3.5 }], 3.5],
        ["null", null, null],
      ];
      for (const [name, tracks, want] of shapes) {
        await clearJobs();
        const p = payload();
        const recordingId = String((await post(p)).json.recordingId);
        await pool.query(`update recordings set metadata = jsonb_set(metadata, '{capture,tracks}', $2::jsonb) where id = $1`, [recordingId, JSON.stringify(tracks)]);
        const jobs = await runToEnd(worker(model(), makeStubEmbedder()), recordingId);
        const row = (await pool.query("select status, duration_sec from recordings where id = $1", [recordingId])).rows[0];
        check(`dur capture.tracks as ${name}: the job is done, the recording ready, duration_sec ${want ?? "null"}`, jobs[0].state === "done" && row.status === "ready" && (want === null ? row.duration_sec === null : Math.abs(Number(row.duration_sec) - want) < 1e-9), JSON.stringify({ job: jobs[0].state, error: jobs[0].lastError, row }));
      }
    }

    // ---- k ---------------------------------------------------------------------
    if (wanted("k")) {
      await clearJobs();
      const stamps: number[] = [];
      let failing = true;
      const query = (async (text: string, params?: unknown[]) => {
        if (failing) {
          stamps.push(Date.now());
          throw new Error("simulated database outage");
        }
        return pool.query(text, params);
      }) as unknown as import("./worker.js").Query;
      const w = new JobWorker({ query, errorRetryMs: 100, errorRetryMaxMs: 400 });
      w.wake();
      await sleep(1750);
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
      const steps = [100, 200, 400, 400, 400];
      check("k a persistent database error is retried at 100, 200, 400, 400, 400 ms and no sooner (one query per step)", gaps.length >= 4 && gaps.every((g, i) => g >= steps[i] - 10 && g <= steps[i] + 150), JSON.stringify({ attempts: stamps.length, gaps }));
      check("k so in 1.75 s that is at most six queries, not one per timer tick", stamps.length >= 5 && stamps.length <= 6, String(stamps.length));
      failing = false;
      w.wake();
      await w.whenIdle();
      failing = true;
      stamps.length = 0;
      w.wake();
      await sleep(600);
      check("k after a pass that succeeds the steps start again at 100 ms", stamps.length >= 2 && stamps[1] - stamps[0] < 200, JSON.stringify({ stamps: stamps.length, firstGap: stamps[1] - stamps[0] }));
      failing = false;
      await w.stop();
    }

    // ---- f ---------------------------------------------------------------------
    // The server as Fly runs it, in its own process: src/index.ts, which listens,
    // loads the app and starts the worker, and whose SIGTERM handler is the one
    // under test. Its worker uses the real Anthropic SDK, pointed (ANTHROPIC_BASE_URL)
    // at an HTTP server here that takes the request and never answers. When that
    // request's connection closes, the abort has reached the wire.
    if (wanted("f")) {
      await clearJobs();
      let requestAt = 0;
      let closedAt = 0;
      const hang = createServer((req, res) => {
        if (!requestAt) requestAt = Date.now();
        req.resume();
        res.on("close", () => {
          if (!closedAt) closedAt = Date.now();
        });
      });
      hang.listen(0, "127.0.0.1");
      await new Promise((r) => hang.once("listening", r));
      try {
        const { recordingId } = await fresh();
        const [before] = await jobsOf(recordingId);
        const lines: { t: number; line: string }[] = [];
        const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
          cwd: resolve(import.meta.dirname, "..", ".."),
          env: { ...process.env, PORT: "0", ANTHROPIC_API_KEY: "stub-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(hang.address() as AddressInfo).port}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        for (const stream of [child.stdout, child.stderr]) {
          createInterface({ input: stream! }).on("line", (line) => {
            lines.push({ t: Date.now(), line });
            captured.push(line);
            realWrite(`    f| ${line}\n`);
          });
        }
        const exited = new Promise<{ code: number | null; signal: string | null; t: number }>((r) => child.once("exit", (code, signal) => r({ code, signal, t: Date.now() })));
        let early: { code: number | null } | null = null;
        void exited.then((e) => (early = e));
        const t0 = Date.now();
        while (!requestAt && !early && Date.now() - t0 < 30_000) await sleep(20);
        const inCall = requestAt > 0 && !early;
        check("f the spawned server's worker claimed the job and is inside the model call", inCall && lines.some((l) => l.line.includes(`jobs: ${before.id} `) && l.line.includes("queued→running (attempt 1)")), JSON.stringify({ requestSeen: requestAt > 0, exitedEarly: early }));
        let ex: { code: number | null; signal: string | null; t: number } | null = null;
        let sigAt = 0;
        if (inCall) {
          await sleep(300); // inside the call, not on its first byte
          sigAt = Date.now();
          child.kill("SIGTERM");
          ex = await Promise.race([exited, sleep(15_000).then(() => null)]);
          if (!ex) {
            child.kill("SIGKILL");
            await exited;
          }
        } else {
          child.kill("SIGKILL");
          await exited;
        }
        const requeuedAt = lines.find((l) => l.line.includes(`jobs: ${before.id} `) && l.line.includes("running→queued"))?.t ?? 0;
        const since = (t: number): string => (t && sigAt ? `${t - sigAt} ms` : "never");
        say(`f timings from SIGTERM: the model request's connection closed ${since(closedAt)}, "running→queued" logged ${since(requeuedAt)}, the process exited ${ex ? since(ex.t) : "never (killed at 15 s)"}`);
        const [after] = await jobsOf(recordingId);
        const allJobs = (await pool.query("select count(*)::int as n from jobs")).rows[0].n;
        const moments = await momentsOf(recordingId);
        const rec = await recOf(recordingId);
        check("f SIGTERM: the process exits 0 inside the 10 s drain cap", !!ex && ex.code === 0 && ex.t - sigAt < 10_000, JSON.stringify({ code: ex?.code, signal: ex?.signal, ms: ex ? ex.t - sigAt : null }));
        check("f the abort reached the model call (its connection closed) and the job was requeued before the exit", closedAt > sigAt && requeuedAt > sigAt && !!ex && requeuedAt <= ex.t, JSON.stringify({ closed: since(closedAt), requeued: since(requeuedAt) }));
        check("f the job is queued again with attempts unchanged and no lease", after.state === "queued" && after.attempts === before.attempts && after.leaseToken === null && after.leaseExpiresAt === null, JSON.stringify({ state: after.state, attemptsBefore: before.attempts, attemptsAfter: after.attempts, hasLease: after.leaseToken !== null, hasExpiry: after.leaseExpiresAt !== null }));
        check("f no rows left: no moments for the recording, it is still pending with no current run, and this is the only job", moments.length === 0 && rec.status === "pending" && rec.run === null && allJobs === 1, JSON.stringify({ moments: moments.length, rec, jobs: allJobs }));
        // Then the job finishes, on one attempt: the shutdown's was not counted.
        const jobs = await runToEnd(worker(model(), makeStubEmbedder()), recordingId);
        check("f afterwards the job runs to done with attempts 1", jobs.length === 1 && jobs[0].state === "done" && jobs[0].attempts === 1 && (await recOf(recordingId)).status === "ready", JSON.stringify(jobs.map((j) => [j.state, j.attempts])));
      } finally {
        hang.closeAllConnections();
        hang.close();
      }
    }

    // ---- e ---------------------------------------------------------------------
    // The server in its own process again, its Anthropic calls answered over HTTP
    // by the stub model here: pass 1 and both pass 2 calls are answered, so the run
    // inserts its moments, and the collapse call is never answered. The process is
    // killed outright there, holding the lease, with a run's rows written and not
    // promoted.
    if (wanted("e")) {
      await clearJobs();
      const remote = model({ onCall: async ({ kind }) => { if (kind === "collapse") await new Promise(() => {}); } });
      const standIn = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          void remote
            .fetch("http://stand-in/v1/messages", { method: "POST", body })
            .then(async (r) => {
              res.writeHead(r.status, Object.fromEntries(r.headers));
              res.end(await r.text());
            })
            .catch(() => res.destroy());
        });
      });
      standIn.listen(0, "127.0.0.1");
      await new Promise((r) => standIn.once("listening", r));
      try {
        const { recordingId } = await fresh();
        const [before] = await jobsOf(recordingId);
        const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
          cwd: resolve(import.meta.dirname, "..", ".."),
          env: { ...process.env, PORT: "0", ANTHROPIC_API_KEY: "stub-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(standIn.address() as AddressInfo).port}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        for (const stream of [child.stdout, child.stderr]) {
          createInterface({ input: stream! }).on("line", (line) => {
            captured.push(line);
            realWrite(`    e| ${line}\n`);
          });
        }
        const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
        let early: { code: number | null } | null = null;
        void exited.then((x) => (early = x));
        const t0 = Date.now();
        while (!remote.calls.includes("collapse") && !early && Date.now() - t0 < 30_000) await sleep(20);
        const mid = (await jobsOf(recordingId))[0];
        const killedRun = mid.runIds[0] ?? "";
        const leftBefore = (await momentsOf(recordingId)).filter((m) => m.run === killedRun).length;
        check("e the spawned server's run wrote its moments and is waiting on the collapse call, holding the job", !early && remote.calls.join(",") === "pass1,pass2,pass2,collapse" && mid.state === "running" && mid.attempts === 1 && mid.runIds.length === 1 && leftBefore > 0, JSON.stringify({ exitedEarly: early, calls: remote.calls, state: mid.state, attempts: mid.attempts, runIds: mid.runIds.length, killedRunRows: leftBefore }));
        child.kill("SIGKILL");
        const ex = await exited;
        check("e the process was killed outright (SIGKILL), with the job still running under its lease", ex.signal === "SIGKILL" && (await jobsOf(recordingId))[0].state === "running", JSON.stringify(ex));

        // A worker here, through its boot path: start() sees the running job's lease
        // in the future and arms its timer for when it runs out.
        const stub = model();
        const w = worker(stub, makeStubEmbedder());
        const tKill = Date.now();
        // The wait for the lease (up to a whole lease, 60 s) is deliberate, not a
        // stall: it gets a fresh watchdog window, and the rest of the run another.
        stall.refresh();
        await w.start();
        const jobs = await settle(recordingId, 90_000);
        say(`e the dead lease ran out and the job was taken over and finished ${Math.round((Date.now() - tKill) / 1000)} s after the kill`);
        stall.refresh();
        await w.stop();
        const rec = await recOf(recordingId);
        const ms = await momentsOf(recordingId);
        const runs = new Set(ms.map((m) => m.run));
        check("e the killed run's leftover rows are deleted", ms.every((m) => m.run !== killedRun), JSON.stringify({ killedRunRowsBefore: leftBefore, killedRunRowsAfter: ms.filter((m) => m.run === killedRun).length }));
        check("e exactly one run is promoted: every moment is the recording's current run, which is the second recorded on the job", runs.size === 1 && ms.length > 0 && ms[0].run === rec.run && jobs[0].runIds.length === 2 && jobs[0].runIds[1] === rec.run, JSON.stringify({ distinctRuns: runs.size, runIds: jobs[0].runIds.length, currentIsSecond: jobs[0].runIds[1] === rec.run }));
        check("e the recording ends ready, the job done", rec.status === "ready" && jobs.length === 1 && jobs[0].state === "done", JSON.stringify({ status: rec.status, jobs: jobs.map((j) => j.state) }));
        check("e attempts is 2: the killed attempt is counted, as only a shutdown or a lost lease gives one back", jobs[0].attempts === before.attempts + 2, JSON.stringify({ before: before.attempts, after: jobs[0].attempts }));
      } finally {
        standIn.closeAllConnections();
        standIn.close();
      }
    }

    // ---- r: the jobs CLI ------------------------------------------------------
    if (wanted("r")) {
      await clearJobs();

      // A job failed on all three attempts, then retried.
      const { recordingId } = await fresh();
      const [failed] = await runToEnd(worker(model({ failStatus: 400 }), makeStubEmbedder()), recordingId);
      const retried = await cli("retry", failed.id);
      const [queued] = await jobsOf(recordingId);
      check("r a failed job (attempts 3) is put back by retry: exit 0, queued, attempts 0, no lease or error left", failed.state === "failed" && failed.attempts === 3 && retried.code === 0 && queued.state === "queued" && queued.attempts === 0 && queued.leaseToken === null && queued.errorClass === null && queued.lastError === null, JSON.stringify({ before: [failed.state, failed.attempts], code: retried.code, after: [queued.state, queued.attempts, queued.errorClass] }));
      const stub = model();
      const [doneJob] = await runToEnd(worker(stub, makeStubEmbedder()), recordingId);
      check("r the retried job runs to done on one attempt, and the recording is ready", doneJob.state === "done" && doneJob.attempts === 1 && (await recOf(recordingId)).status === "ready" && stub.calls.length === 4, JSON.stringify({ state: doneJob.state, attempts: doneJob.attempts, calls: stub.calls.length }));

      // Refusals: a running job, an unknown id, a malformed one.
      const other = await fresh();
      await setState(other.recordingId, "running");
      const [running] = await jobsOf(other.recordingId);
      const onRunning = await cli("retry", running.id);
      const [stillRunning] = await jobsOf(other.recordingId);
      check("r retry refuses a running job: exit 1, says it is running, the row untouched", onRunning.code === 1 && onRunning.err.includes("is running, not failed") && stillRunning.state === "running" && stillRunning.attempts === running.attempts, JSON.stringify({ code: onRunning.code, err: onRunning.err.trim(), state: stillRunning.state }));
      const unknown = randomUUID();
      const onUnknown = await cli("retry", unknown);
      check("r retry refuses an unknown id: exit 1, 'no job with id'", onUnknown.code === 1 && onUnknown.err.includes(`no job with id ${unknown}`), JSON.stringify({ code: onUnknown.code, err: onUnknown.err.trim() }));
      const onMalformed = await cli("retry", "not-a-uuid");
      check("r retry refuses a malformed id the same way, not with a database error", onMalformed.code === 1 && onMalformed.err.trim() === "jobs: no job with id not-a-uuid", JSON.stringify({ code: onMalformed.code, err: onMalformed.err.trim() }));

      // list: both jobs, by id and state, and no call content. The phrase is in the
      // database (the done recording's moments), so its absence here is the list's.
      const listed = await cli("list");
      const phraseInDb = (await pool.query("select count(*)::int as n from moments where recording_id = $1 and title like $2", [recordingId, `%${PHRASE}%`])).rows[0].n;
      const lineOf = (id: string): string => listed.out.split("\n").find((l) => l.includes(id)) ?? "";
      check("r list exits 0 with one line per job, each with its recording, kind, state and attempts", listed.code === 0 && / done +attempts=1 /.test(lineOf(failed.id)) && lineOf(failed.id).includes(`recording=${recordingId} extract`) && / running +attempts=0 /.test(lineOf(running.id)), JSON.stringify({ code: listed.code, lines: [lineOf(failed.id), lineOf(running.id)] }));
      check("r list holds the planted phrase nowhere, though the recording's moments carry it", phraseInDb > 0 && !`${listed.out}${listed.err}`.includes(PHRASE), JSON.stringify({ phraseInMoments: phraseInDb }));
      await clearJobs();
    }

    // ---- no content in any log -----------------------------------------------------
    check("no log line written during the whole run holds the planted phrase", !captured.some((l) => l.includes(PHRASE)), captured.filter((l) => l.includes(PHRASE)).slice(0, 3).join("\n     "));
  } finally {
    clearTimeout(stall);
    // Every step is allowed to fail on its own: a database that is down must not
    // stop the next step, and the account is dropped whenever it can be.
    const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        failures++;
        say(`check-jobs: cleanup step "${what}" failed: ${firstLine(e)}`);
      }
    };
    await attempt("stop the workers", () => Promise.all(workers.map((w) => w.stop())));
    // A spawned server still running (case f gave up on it) holds a pool of its own.
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    await attempt("read the lease-lost lookups", () => Promise.all(leaseLostLookups));
    say(`LEASELOST events this run: ${leaseLost.length}`);
    for (const e of leaseLost) say(`LEASELOST job=${e.jobId.slice(0, 8)} doneLineLoggedBefore=${e.doneLineBefore} dbStateAfter=${e.dbState}`);
    say(`background errors this run: ${backgroundErrors.length}${backgroundErrors.length ? `\n     ${backgroundErrors.slice(0, 5).join("\n     ")}` : ""}`);
    if (backgroundErrors.length > 0) failures++;
    await attempt("close the server", async () => {
      server.close();
    });
    await attempt("drop the run's account", () => dropAccount(fx));
    await attempt("end the pool", () => endPool());
  }
  say(failures === 0 ? "\ncheck-jobs: all passed" : `\ncheck-jobs: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  say(`check-jobs: crashed: ${err instanceof Error ? (err.stack ?? err.message).split("\n").slice(0, 4).join(" | ") : String(err)}`);
  process.exit(1);
});
