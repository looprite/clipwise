// Check for the jobs table, the enqueue and (as the later items land) the worker
// (SAA-227 parts D and E). Real code and the real database throughout; the only
// stand-ins are the two paid services (extract/stub-model.ts) and the request's
// sign-in (a middleware that sets the access context the capture-token guard would;
// who may call is check-access's business, not this check's).
//
// Cases:
//   a0  a first POST /captures stores the capture and queues one extract job, in
//       the same transaction
//   b   a repeat POST makes no job
//   c   a late identity answer that names a speaker, on a recording whose
//       extraction is complete, queues a re-extract job
//   c2  a late identity answer while the first extract job is
//         queued   nothing is queued (the job reads the speakers when it runs)
//         running  a re-extract is queued (the job may have read them before)
//         failed   nothing is queued
//       and one that names nobody new queues nothing
//
// CLIPWISE_CHECK_CONTROL=<case,case> runs only those cases (scratch-db.sh passes
// the variable through). A control is a case run against code with its
// protection taken out; see the item's commit message in the log for each.
//
//   scripts/scratch-db.sh run check-jobs

import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { capturesPost } from "../routes/captures.js";
import { errorHandler } from "../lib/http.js";

const only = (process.env.CLIPWISE_CHECK_CONTROL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const wanted = (name: string): boolean => only.length === 0 || only.includes(name);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string };
const SEGS: Seg[] = [
  { track: "me", startMs: 0, endMs: 1500, text: "hello there" },
  { track: "them", startMs: 1600, endMs: 3000, text: "hi" },
  { track: "me", startMs: 3100, endMs: 4000, text: "shall we begin" },
  { track: "them", startMs: 4100, endMs: 5000, text: "yes" },
];

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
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[] },
    capture: { tracks: { tap: { verdict: "ok" }, mic: { verdict: "ok" } }, permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
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
  const fx: Fixture = await makeAccount("check-jobs");

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
  const jobsOf = (recordingId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.recordingId, recordingId)).orderBy(schema.jobs.createdAt);
  const speakersOf = (recordingId: string) => db.select({ label: schema.speakers.label, name: schema.speakers.displayName }).from(schema.speakers).where(eq(schema.speakers.recordingId, recordingId));
  // A recording whose extraction finished, as the promotion leaves it.
  const markComplete = async (recordingId: string): Promise<void> => {
    await db.execute(sql`update recordings set status = 'ready', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('current_extraction_run', ${randomUUID()}::text) where id = ${recordingId}`);
    await db.update(schema.jobs).set({ state: "done" }).where(eq(schema.jobs.recordingId, recordingId));
  };
  const setState = (recordingId: string, state: string) => db.update(schema.jobs).set({ state }).where(eq(schema.jobs.recordingId, recordingId));

  try {
    // a0 + b
    if (wanted("a0") || wanted("b")) {
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

    // c
    if (wanted("c")) {
      const p = payload();
      const recordingId = String((await post(p)).json.recordingId);
      await markComplete(recordingId);
      const late = await post({ ...p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      const jobs = await jobsOf(recordingId);
      const re = jobs.filter((j) => j.kind === "re_extract");
      check("c a late answer naming the host on a complete recording is 200 identityApplied and queues one re_extract", late.status === 200 && late.json.identityApplied === true && re.length === 1 && re[0].state === "queued", JSON.stringify({ status: late.status, jobs: jobs.map((j) => [j.kind, j.state]) }));
      check("c the name is on the speaker row", (await speakersOf(recordingId)).some((s) => s.label === "me" && s.name === "Host Name"));
      const sameAgain = await post({ ...p, identity: answer("2026-10-10T10:05:00Z", "Host Name") });
      check("c the same answer again applies nothing and queues nothing", sameAgain.json.identityApplied === false && (await jobsOf(recordingId)).filter((j) => j.kind === "re_extract").length === 1);
      const guestLater = await post({ ...p, identity: answer("2026-10-10T10:09:00Z", "Host Name", ["Guest Name"]) });
      check("c a newer answer naming a guest while a re_extract is already queued adds none (the index)", guestLater.json.identityApplied === true && (await jobsOf(recordingId)).filter((j) => j.kind === "re_extract").length === 1);
    }

    // c2
    if (wanted("c2")) {
      const mk = async (state: string | null): Promise<{ p: Record<string, unknown>; recordingId: string }> => {
        const p = payload();
        const recordingId = String((await post(p)).json.recordingId);
        if (state) await setState(recordingId, state);
        return { p, recordingId };
      };
      const reCount = async (recordingId: string): Promise<number> => (await jobsOf(recordingId)).filter((j) => j.kind === "re_extract").length;

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
  } finally {
    server.close();
    await dropAccount(fx);
    await endPool();
  }
  console.log(failures === 0 ? "\ncheck-jobs: all passed" : `\ncheck-jobs: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`check-jobs: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
