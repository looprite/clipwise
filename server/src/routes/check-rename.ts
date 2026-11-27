// Check for renaming a call (SAA-135): POST /captures/:captureId/title, the
// title in GET /captures/:captureId/jobs, and GET /captures/titles. Real routes
// and the real database (a scratch branch); the request's sign-in is a
// middleware that sets the access context the capture-token guard would. Every
// name and title is invented.
//
//   r1  the owner renames: 200, the stored title decrypts to it, source member
//   r2  another member of the account: 404 capture_not_found, the stored
//       ciphertext unchanged
//   r3  a blank title, one over 200 characters, one with a control character:
//       400 each, the title unchanged
//   r4  the rename's log line has ids and a length, never the title; control:
//       the title is in the read-back
//   r5  a trashed capture: 404
//   r6  a renamed title survives a later calendar match; the invitees are
//       still written
//   r7  a renamed title survives a later correction of who was on the call
//   r8  the jobs reply carries the title: the renamed one; a fallback with no
//       match job; null while it is still the placeholder
//   r9  GET /captures/titles: the caller's own captures with those titles, not
//       another member's, not a trashed one
//   r10 GET /captures/titles writes one access line, ids only
//
//   scripts/scratch-db.sh run check-rename

import { eq, sql } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, pool, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { applyCalendarMatch } from "../ingest/calendar-match.js";
import { errorHandler } from "../lib/http.js";
import { captureScopeRouter, captureTitlesGet } from "./capture-scope.js";
import { capturesPost } from "./captures.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

type Answer = { guests: Array<{ name: string }>; answeredAt: string; corrects?: string };

function payload(captureId: string, stem: string, answer?: Answer): Record<string, unknown> {
  const segments = [{ track: "me", startMs: 0, endMs: 1500, text: "hello" }, { track: "them", startMs: 2000, endMs: 4000, text: "hi" }];
  const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 4, gaps: [], note: "check" });
  return {
    captureId,
    startedAt: "2026-11-26T11:00:00.000Z",
    stem,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: 7, countedFrom: "check-rename" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...(answer
      ? { identity: { identity_version: 2, stem, answered_at: answer.answeredAt, self: { name: "Hal Brennan", source: "check" }, guests: answer.guests, scope: "work", ...(answer.corrects ? { corrects: answer.corrects } : {}) } }
      : {}),
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-rename");
  const fx = await makeAccount("check-rename");
  const [other] = await db
    .insert(schema.accountMembers)
    .values({ accountId: fx.accountId, email: `check-rename-other-${fx.tag}@clipwise.test`, role: "member", joinedAt: new Date() })
    .returning();
  const ctxOf = (memberId: string, email: string) => ({ accountId: fx.accountId, memberId, role: "member", authUserId: "check", email, scope: ["clipwise:capture"] });
  const owner = ctxOf(fx.memberId, `check-rename-${fx.tag}@clipwise.test`);
  const someoneElse = ctxOf(other.id, other.email);
  let current = owner;

  // Every line the server writes, for r4 and r10: console.log, and anything
  // written to stdout or stderr directly. console.log itself writes through
  // process.stdout.write, so while it runs the stream patch does not add the
  // same line a second time.
  const lines: string[] = [];
  const keep = (chunk: unknown) => {
    for (const l of String(chunk).split("\n")) if (l !== "") lines.push(l);
  };
  const realLog = console.log;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let inLog = false;
  console.log = (...args: unknown[]) => {
    keep(args.map(String).join(" "));
    inLog = true;
    try {
      realLog(...args);
    } finally {
      inLog = false;
    }
  };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!inLog) keep(chunk);
    return (realOut as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    keep(chunk);
    return (realErr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = current as typeof req.access;
    next();
  });
  app.post("/captures", capturesPost);
  app.get("/captures/titles", captureTitlesGet);
  app.use(captureScopeRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fresh = () => {
    const captureId = randomUUID().toUpperCase();
    return { captureId, stem: `check-rename-${captureId.slice(0, 8).toLowerCase()}` };
  };
  const upload = async (c: { captureId: string; stem: string }, answer?: Answer): Promise<string> => {
    const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload(c.captureId, c.stem, answer)) });
    const json = (await res.json()) as { recordingId?: string };
    if (!res.ok || !json.recordingId) throw new Error(`POST /captures ${res.status} ${JSON.stringify(json)}`);
    return json.recordingId;
  };
  const rename = async (captureId: string, title: unknown) => {
    const res = await fetch(`${base}/captures/${captureId}/title`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const read = async (id: string) => {
    const [r] = await db.select({ title: schema.recordings.title, titleSource: schema.recordings.titleSource }).from(schema.recordings).where(eq(schema.recordings.id, id));
    return r;
  };
  const cipherHash = async (id: string) => (await pool.query<{ h: string }>("select md5(title) as h from recordings where id = $1", [id])).rows[0]?.h;

  const NEW_TITLE = "Renamed Planning Call (invented)";
  try {
    // r1, r4.
    const a = fresh();
    const recA = await upload(a, { guests: [{ name: "Ada Quill" }], answeredAt: "2026-11-26T12:00:00.000Z" });
    const mark = lines.length;
    const r1 = await rename(a.captureId, NEW_TITLE);
    const renameLines = lines.slice(mark);
    let r = await read(recA);
    check("r1: the owner renames", r1.status === 200 && r1.json?.title === NEW_TITLE && r.title === NEW_TITLE && r.titleSource === "member", `${r1.status} ${JSON.stringify(r1.json)} stored=${JSON.stringify(r)}`);
    const logged = renameLines.filter((l) => l.startsWith("title: "));
    check(
      "r4: the rename's log line has ids and a length, never the title",
      logged.length === 1 && logged[0].includes(`recording=${recA}`) && logged[0].includes(`renamed chars=${NEW_TITLE.length}`) && !renameLines.some((l) => l.includes("Renamed Planning")) && r.title === NEW_TITLE,
      JSON.stringify(renameLines),
    );

    // r2.
    const before = await cipherHash(recA);
    current = someoneElse;
    const r2 = await rename(a.captureId, "Not Theirs To Rename");
    current = owner;
    const after = await cipherHash(recA);
    check("r2: another member gets 404 and the title is unchanged", r2.status === 404 && r2.json?.error === "capture_not_found" && before === after, `${r2.status} ${JSON.stringify(r2.json)} before=${before} after=${after}`);

    // r3.
    const bad = [await rename(a.captureId, "   "), await rename(a.captureId, "x".repeat(201)), await rename(a.captureId, "line\nbreak"), await rename(a.captureId, 42)];
    r = await read(recA);
    check("r3: blank, too long, a control character, not a string: 400 each, unchanged", bad.every((b) => b.status === 400) && r.title === NEW_TITLE, `${bad.map((b) => b.status).join(",")} stored=${JSON.stringify(r.title)}`);

    // r5.
    const t = fresh();
    await upload(t);
    const trashed = await fetch(`${base}/captures/${t.captureId}/trash`, { method: "POST" });
    const r5 = await rename(t.captureId, "Too Late (invented)");
    check("r5: a trashed capture: 404", trashed.status === 200 && r5.status === 404, `trash=${trashed.status} rename=${r5.status}`);

    // r6.
    const app6 = await applyCalendarMatch(db, fx.accountId, recA, a.stem, {
      event_id: "evt-check-rename",
      title: "Some Event (invented)",
      recurring_event_id: null,
      ical_uid: null,
      original_start_time: null,
      occurrence_key: null,
      occurrence_key_rule: null,
      invitees: [{ email: `guest-${fx.tag}@clipwise.test`, name: "Ada Quill", response_status: "accepted" }],
      offset_ms: 0,
    });
    r = await read(recA);
    const invitees = (await pool.query<{ n: number }>("select count(*)::int as n from invitees where recording_id = $1", [recA])).rows[0].n;
    check("r6: a renamed title survives a later calendar match", !app6.titleApplied && r.title === NEW_TITLE && r.titleSource === "member" && invitees === 1, `applied=${app6.titleApplied} stored=${JSON.stringify(r)} invitees=${invitees}`);

    // r7.
    await upload(a, { guests: [{ name: "Ben Marlow" }], answeredAt: "2026-11-26T12:05:00.000Z", corrects: "2026-11-26T12:00:00.000Z" });
    r = await read(recA);
    check("r7: a renamed title survives a later correction", r.title === NEW_TITLE && r.titleSource === "member", JSON.stringify(r));

    // r8.
    const f = fresh();
    await upload(f, { guests: [{ name: "Cara Voss" }], answeredAt: "2026-11-26T12:10:00.000Z" });
    const p = fresh();
    await upload(p);
    const jobsTitle = async (captureId: string) => ((await (await fetch(`${base}/captures/${captureId}/jobs`)).json()) as { title?: unknown }).title;
    const [jA, jF, jP] = [await jobsTitle(a.captureId), await jobsTitle(f.captureId), await jobsTitle(p.captureId)];
    check("r8: the jobs reply carries the title", jA === NEW_TITLE && jF === "Call with Cara Voss" && jP === null, `renamed=${JSON.stringify(jA)} fallback=${JSON.stringify(jF)} placeholder=${JSON.stringify(jP)}`);

    // r9, r10.
    current = someoneElse;
    const o = fresh();
    await upload(o, { guests: [{ name: "Dov Ellery" }], answeredAt: "2026-11-26T12:15:00.000Z" });
    current = owner;
    const mark10 = lines.length;
    const listed = await fetch(`${base}/captures/titles?since=2026-11-01T00:00:00.000Z`);
    const body = (await listed.json()) as { titles?: Array<{ captureId: string; title: string | null }> };
    const byId = new Map((body.titles ?? []).map((x) => [x.captureId, x.title]));
    check(
      "r9: GET /captures/titles lists the caller's own captures, not another member's, not a trashed one",
      listed.status === 200 &&
        byId.get(a.captureId) === NEW_TITLE &&
        byId.get(f.captureId) === "Call with Cara Voss" &&
        byId.has(p.captureId) &&
        byId.get(p.captureId) === null &&
        !byId.has(o.captureId) &&
        !byId.has(t.captureId),
      `${listed.status} ${JSON.stringify(body)}`,
    );
    const access = lines.slice(mark10).filter((l) => l.startsWith("access: "));
    check(
      "r10: GET /captures/titles writes one access line, ids only",
      access.length === 1 && access[0].includes(`member=${fx.memberId}`) && access[0].includes("route=capture.titles") && access[0].includes("recordings=3") && !access[0].includes("Cara"),
      JSON.stringify(access),
    );
  } finally {
    console.log = realLog;
    process.stdout.write = realOut as typeof process.stdout.write;
    process.stderr.write = realErr as typeof process.stderr.write;
    server.close();
    await db.execute(sql`delete from recordings where account_id = ${fx.accountId}`);
    await db.delete(schema.accountMembers).where(eq(schema.accountMembers.id, other.id));
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
