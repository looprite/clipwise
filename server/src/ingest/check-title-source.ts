// Check for title_source (SAA-135): which writer may replace a recording's title.
// Real routes and the real database (a scratch branch); the request's sign-in is
// a middleware that sets the access context the capture-token guard would. Every
// name is invented.
//
// The fallback, through POST /captures:
//   t1  control: an upload with no answer keeps the placeholder (source placeholder)
//   t2  an upload whose answer names one guest: "Call with Ada Quill" (fallback)
//   t3  a correction naming two: "Call with Ada Quill and Ben Marlow" (fallback)
//   t4  a personal call, one guest: "Call with Etta Quill" (fallback, scope personal)
//   t5  an answer naming nobody: "Call" (fallback)
//   t6  a late answer on an upload that had none: "Call with Cara Voss" (fallback)
// The calendar match (applyCalendarMatch):
//   t7  control: it replaces the placeholder (source calendar)
//   t8  it replaces a fallback (source calendar)
//   t9  a second match does not replace a calendar title (custom_title)
//   t10 a correction does not replace a calendar title
//   t11 a member title: not replaced by a match, nor by a correction
//   t12 a row with no source (before the backfill): the exact placeholder is
//       replaced, as before; any other title is not
//
//   scripts/scratch-db.sh run check-title-source

import { eq } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { errorHandler } from "../lib/http.js";
import { capturesPost } from "../routes/captures.js";
import { applyCalendarMatch, type CalendarMatch } from "./calendar-match.js";
import { titlePlaceholderFor } from "./clipwise.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

type Guest = { name: string };
type Answer = { guests: Guest[]; scope?: "work" | "personal"; answeredAt: string; corrects?: string };

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
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: 7, countedFrom: "check-title-source" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: { key: "check", name: "Check App" } },
    ...(answer
      ? {
          identity: {
            identity_version: 2,
            stem,
            answered_at: answer.answeredAt,
            self: { name: "Hal Brennan", source: "check" },
            guests: answer.guests,
            scope: answer.scope ?? "work",
            ...(answer.corrects ? { corrects: answer.corrects } : {}),
          },
        }
      : {}),
  };
}

function match(title: string): CalendarMatch {
  return {
    event_id: `evt-${randomUUID().slice(0, 8)}`,
    title,
    recurring_event_id: null,
    ical_uid: null,
    original_start_time: null,
    occurrence_key: null,
    occurrence_key_rule: null,
    invitees: [],
    offset_ms: 0,
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-title-source");
  const fx = await makeAccount("check-title-source");
  const ctx = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: `check-title-source-${fx.tag}@clipwise.test`, scope: ["clipwise:capture"] };
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

  const upload = async (captureId: string, stem: string, answer?: Answer): Promise<string> => {
    const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload(captureId, stem, answer)) });
    const json = (await res.json()) as { recordingId?: string };
    if (!res.ok || !json.recordingId) throw new Error(`POST /captures ${res.status} ${JSON.stringify(json)}`);
    return json.recordingId;
  };
  const read = async (id: string) => {
    const [r] = await db
      .select({ title: schema.recordings.title, titleSource: schema.recordings.titleSource, scope: schema.recordings.scope })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, id));
    return r;
  };
  const shown = (r: { title: string | null; titleSource: string | null; scope?: string | null }) => `title=${JSON.stringify(r.title)} source=${r.titleSource} scope=${r.scope ?? "-"}`;
  const fresh = () => {
    const captureId = randomUUID().toUpperCase();
    return { captureId, stem: `check-title-source-${captureId.slice(0, 8).toLowerCase()}` };
  };

  try {
    // t1, then t6 on the same capture.
    const a = fresh();
    const recA = await upload(a.captureId, a.stem);
    let r = await read(recA);
    check("t1: control: an upload with no answer keeps the placeholder", r.title === titlePlaceholderFor(a.stem) && r.titleSource === "placeholder", shown(r));
    await upload(a.captureId, a.stem, { guests: [{ name: "Cara Voss" }], answeredAt: "2026-11-26T11:30:00.000Z" });
    r = await read(recA);
    check("t6: a late answer on an upload that had none", r.title === "Call with Cara Voss" && r.titleSource === "fallback", shown(r));

    // t2, t3.
    const b = fresh();
    const recB = await upload(b.captureId, b.stem, { guests: [{ name: "Ada Quill" }], answeredAt: "2026-11-26T11:31:00.000Z" });
    r = await read(recB);
    check("t2: an upload whose answer names one guest", r.title === "Call with Ada Quill" && r.titleSource === "fallback", shown(r));
    await upload(b.captureId, b.stem, { guests: [{ name: "Ada Quill" }, { name: "Ben Marlow" }], answeredAt: "2026-11-26T11:32:00.000Z", corrects: "2026-11-26T11:31:00.000Z" });
    r = await read(recB);
    check("t3: a correction naming two", r.title === "Call with Ada Quill and Ben Marlow" && r.titleSource === "fallback", shown(r));

    // t4.
    const c = fresh();
    const recC = await upload(c.captureId, c.stem, { guests: [{ name: "Etta Quill" }], scope: "personal", answeredAt: "2026-11-26T11:33:00.000Z" });
    r = await read(recC);
    check("t4: a personal call, one guest", r.title === "Call with Etta Quill" && r.titleSource === "fallback" && r.scope === "personal", shown(r));

    // t5.
    const d = fresh();
    const recD = await upload(d.captureId, d.stem, { guests: [], answeredAt: "2026-11-26T11:34:00.000Z" });
    r = await read(recD);
    check("t5: an answer naming nobody", r.title === "Call" && r.titleSource === "fallback", shown(r));

    // t7: a fresh upload, no answer, matched.
    const e = fresh();
    const recE = await upload(e.captureId, e.stem);
    const app7 = await applyCalendarMatch(db, fx.accountId, recE, e.stem, match("Quarterly Review (invented)"));
    r = await read(recE);
    check("t7: control: the match replaces the placeholder", app7.titleApplied && r.title === "Quarterly Review (invented)" && r.titleSource === "calendar", `${shown(r)} applied=${app7.titleApplied}`);

    // t8, t9, t10 on recB (a fallback).
    const app8 = await applyCalendarMatch(db, fx.accountId, recB, b.stem, match("Design Sync (invented)"));
    r = await read(recB);
    check("t8: the match replaces a fallback", app8.titleApplied && r.title === "Design Sync (invented)" && r.titleSource === "calendar", `${shown(r)} applied=${app8.titleApplied}`);
    const app9 = await applyCalendarMatch(db, fx.accountId, recB, b.stem, match("Another Event (invented)"));
    r = await read(recB);
    check(
      "t9: a second match does not replace a calendar title",
      !app9.titleApplied && app9.titleSkipReason === "custom_title" && r.title === "Design Sync (invented)" && r.titleSource === "calendar",
      `${shown(r)} applied=${app9.titleApplied} reason=${app9.titleSkipReason}`,
    );
    await upload(b.captureId, b.stem, { guests: [{ name: "Fen Okafor" }], answeredAt: "2026-11-26T11:35:00.000Z", corrects: "2026-11-26T11:32:00.000Z" });
    r = await read(recB);
    check("t10: a correction does not replace a calendar title", r.title === "Design Sync (invented)" && r.titleSource === "calendar", shown(r));

    // t11 on recC: a member title, set here as the rename route sets it.
    await db.update(schema.recordings).set({ title: "Typed By Member", titleSource: "member" }).where(eq(schema.recordings.id, recC));
    const app11 = await applyCalendarMatch(db, fx.accountId, recC, c.stem, match("Some Event (invented)"));
    await upload(c.captureId, c.stem, { guests: [{ name: "Gil Arden" }], scope: "personal", answeredAt: "2026-11-26T11:36:00.000Z", corrects: "2026-11-26T11:33:00.000Z" });
    r = await read(recC);
    check(
      "t11: a member title is replaced by neither a match nor a correction",
      !app11.titleApplied && app11.titleSkipReason === "custom_title" && r.title === "Typed By Member" && r.titleSource === "member",
      `${shown(r)} applied=${app11.titleApplied} reason=${app11.titleSkipReason}`,
    );

    // t12: rows with no source, as before the backfill.
    const f = fresh();
    const recF = await upload(f.captureId, f.stem);
    await db.update(schema.recordings).set({ titleSource: null }).where(eq(schema.recordings.id, recF));
    const app12a = await applyCalendarMatch(db, fx.accountId, recF, f.stem, match("Legacy Event (invented)"));
    const rA = await read(recF);
    const g = fresh();
    const recG = await upload(g.captureId, g.stem);
    await db.update(schema.recordings).set({ title: "An Older Title", titleSource: null }).where(eq(schema.recordings.id, recG));
    const app12b = await applyCalendarMatch(db, fx.accountId, recG, g.stem, match("Legacy Event (invented)"));
    const rB = await read(recG);
    check(
      "t12: no source: the exact placeholder is replaced, any other title is not",
      app12a.titleApplied && rA.title === "Legacy Event (invented)" && rA.titleSource === "calendar" && !app12b.titleApplied && rB.title === "An Older Title" && rB.titleSource === null,
      `placeholder row: ${shown(rA)} applied=${app12a.titleApplied}; other row: ${shown(rB)} applied=${app12b.titleApplied}`,
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
