// Check for the title_source backfill (SAA-135, db/backfill-title-source.ts), on
// a scratch branch. Rows as they stand before the column: recorder captures
// with no title_source. Every name and title is invented.
//
//   b1  the dry run counts each kind and writes nothing
//   b2  --apply with the wrong --expect: refused, rolled back, nothing changed
//   b3  --apply with the right --expect: an answered placeholder gets its
//       fallback ("Call with Ada Quill", fallback); an unanswered one keeps the
//       placeholder (placeholder); any other title is kept (calendar)
//   b4  a second --apply changes nothing
//   b5  a row that is not a recorder capture keeps no source
//   b6  a recorder row that already has a source is left as it is
//
// The counts are the whole branch's, so it expects the scratch branch to hold no
// other recorder rows (each check deletes its own).
//
//   scripts/scratch-db.sh run check-backfill-title-source

import { eq } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, schema } from "./index.js";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { titlePlaceholderFor } from "../ingest/clipwise.js";
import { errorHandler } from "../lib/http.js";
import { capturesPost } from "../routes/captures.js";
import { runTitleSourceBackfill } from "./backfill-title-source.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

function payload(captureId: string, stem: string, guests?: Array<{ name: string }>): Record<string, unknown> {
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
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: 7, countedFrom: "check-backfill-title-source" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...(guests ? { identity: { identity_version: 2, stem, answered_at: "2026-11-26T12:00:00.000Z", self: { name: "Hal Brennan", source: "check" }, guests, scope: "work" } } : {}),
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-backfill-title-source");
  const fx = await makeAccount("check-backfill-title-source");
  const ctx = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: `check-backfill-title-source-${fx.tag}@clipwise.test`, scope: ["clipwise:capture"] };
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

  const upload = async (guests?: Array<{ name: string }>) => {
    const captureId = randomUUID().toUpperCase();
    const stem = `check-backfill-${captureId.slice(0, 8).toLowerCase()}`;
    const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload(captureId, stem, guests)) });
    const json = (await res.json()) as { recordingId?: string };
    if (!res.ok || !json.recordingId) throw new Error(`POST /captures ${res.status} ${JSON.stringify(json)}`);
    return { id: json.recordingId, stem };
  };
  const read = async (id: string) => {
    const [r] = await db.select({ title: schema.recordings.title, titleSource: schema.recordings.titleSource }).from(schema.recordings).where(eq(schema.recordings.id, id));
    return r;
  };
  const shown = (r: { title: string | null; titleSource: string | null }) => `title=${JSON.stringify(r.title)} source=${r.titleSource}`;

  try {
    // As before the column: the answered one back on its placeholder, all three
    // with no source.
    const answered = await upload([{ name: "Ada Quill" }]);
    await db.update(schema.recordings).set({ title: titlePlaceholderFor(answered.stem), titleSource: null }).where(eq(schema.recordings.id, answered.id));
    const unanswered = await upload();
    await db.update(schema.recordings).set({ titleSource: null }).where(eq(schema.recordings.id, unanswered.id));
    const matched = await upload();
    await db.update(schema.recordings).set({ title: "Board Prep (invented)", titleSource: null }).where(eq(schema.recordings.id, matched.id));
    const renamed = await upload();
    await db.update(schema.recordings).set({ title: "Typed By Member", titleSource: "member" }).where(eq(schema.recordings.id, renamed.id));
    const other = await makeRecording(fx, { segments: 1 });

    // b1.
    const dry = await runTitleSourceBackfill({ apply: false });
    const afterDry = [await read(answered.id), await read(unanswered.id), await read(matched.id)];
    check(
      "b1: the dry run counts each kind and writes nothing",
      dry.plan.toFallback === 1 && dry.plan.toPlaceholder === 1 && dry.plan.toCalendar === 1 && dry.plan.total === 3 && dry.changed === 0 && afterDry.every((r) => r.titleSource === null),
      `${JSON.stringify(dry)} ${afterDry.map(shown).join("; ")}`,
    );

    // b2.
    const wrong = await runTitleSourceBackfill({ apply: true, expect: 2 });
    const afterWrong = [await read(answered.id), await read(unanswered.id), await read(matched.id)];
    check(
      "b2: the wrong --expect is refused and rolled back",
      !wrong.applied && wrong.changed === 0 && typeof wrong.refused === "string" && afterWrong.every((r) => r.titleSource === null) && afterWrong[0].title === titlePlaceholderFor(answered.stem),
      `${JSON.stringify(wrong)} ${afterWrong.map(shown).join("; ")}`,
    );

    // b3.
    const right = await runTitleSourceBackfill({ apply: true, expect: 3 });
    const [a, u, m] = [await read(answered.id), await read(unanswered.id), await read(matched.id)];
    check(
      "b3: the right --expect: fallback, placeholder and calendar",
      right.applied &&
        right.changed === 3 &&
        a.title === "Call with Ada Quill" &&
        a.titleSource === "fallback" &&
        u.title === titlePlaceholderFor(unanswered.stem) &&
        u.titleSource === "placeholder" &&
        m.title === "Board Prep (invented)" &&
        m.titleSource === "calendar",
      `${JSON.stringify(right)} answered: ${shown(a)}; unanswered: ${shown(u)}; matched: ${shown(m)}`,
    );

    // b4.
    const again = await runTitleSourceBackfill({ apply: true, expect: 0 });
    check("b4: a second --apply changes nothing", again.applied && again.changed === 0 && again.plan.total === 0, JSON.stringify(again));

    // b5, b6.
    const o = await read(other);
    const r = await read(renamed.id);
    check("b5: a row that is not a recorder capture keeps no source", o.titleSource === null && o.title === "check recording", shown(o));
    check("b6: a recorder row that already has a source is left as it is", r.title === "Typed By Member" && r.titleSource === "member", shown(r));
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
