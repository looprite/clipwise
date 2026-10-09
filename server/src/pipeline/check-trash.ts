// Regression check for trash, restore and permanent delete (SAA-154).
//
// Files are made-up captures in a temporary folder, never the live recordings
// folder (recovery scans it). Rows are throwaway, in a throwaway account that
// is deleted at the end, so Claude's real account never sees them. The real
// routers (moments, transcript, recordings) are mounted in-process and called
// over HTTP, so a missing join or a wrong filter fails here rather than on a
// live search. Recovery is run for real against the temporary folder, but
// only ever with every unfinished capture trashed (or in a dry run), so a
// real pass never starts a pipeline, and the check asserts it did not.
//
// Usage:
//   tsx src/pipeline/check-trash.ts

import express from "express";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";

import { db, pool, schema } from "../db/index.js";
import { CLIPWISE_SOURCE } from "../ingest/clipwise.js";
import { TERMINAL_STATUS } from "../extract/extract.js";
import { errorHandler } from "../lib/http.js";
import { captureFiles, isTrashed, markerPath, readMarker, trashedStems, writeMarker } from "../lib/trash-marker.js";
import { momentsRouter } from "../routes/moments.js";
import { recordingsRouter } from "../routes/recordings.js";
import { transcriptRouter } from "../routes/transcript.js";
import { runRecoveryPass } from "./recover.js";
import { deleteCapture, reconcileTrash, restoreCapture, trashCapture, TrashError } from "./trash.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail}`}`);
  if (!ok) failed++;
}

const run = randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), "clipwise-trash-check-"));

type Cap = { stem: string; sourceId: string; term: string; rowId: string; momentId: string };
const mkStem = (n: number): string => `2026-03-0${n}T10-00-0${n}Z`;
const caps: Record<string, Cap> = {};
const SHARED = `sharedterm${run}`;
const ROW_PREFIX = `check-trash-${run}-`;
// The throwaway account's one member, who owns every row and is the caller the
// routers see (they need an access context since the access layer). Set once
// the account exists.
let ownerMemberId: string | undefined;

function writeFiles(c: Cap): void {
  const w = (name: string, body = "{}") => writeFileSync(join(dir, name), body);
  w(`manifest-${c.stem}.json`, JSON.stringify({ recording_id: c.sourceId, stem: c.stem }));
  w(`pipeline-${c.stem}.json`, JSON.stringify({ db_recording_id: c.rowId }));
  w(`transcript-${c.stem}.json`);
  w(`mic-${c.stem}.wav`, "RIFF");
  w(`system-${c.stem}.f32le.pcm`, "pcm");
  w(`mic-${c.stem}.log`, "log");
  w(`voice-clip-${c.stem}-1-1.wav`, "RIFF");
}
const FILES_PER_CAPTURE = 7; // no identity or voice-names answer: recovery must have nothing to apply

async function makeRow(accountId: string, key: string, n: number, status: string): Promise<void> {
  const stem = mkStem(n);
  const sourceId = `${ROW_PREFIX}${key}`;
  const [rec] = await db
    .insert(schema.recordings)
    .values({
      accountId,
      ownerMemberId,
      slug: `${ROW_PREFIX}${key}`,
      title: `Check ${key}`,
      source: CLIPWISE_SOURCE,
      sourceId,
      status,
      startedAt: new Date(`2026-03-0${n}T10:00:0${n}Z`),
      metadata: status === TERMINAL_STATUS ? { current_extraction_run: "run1" } : null,
    })
    .returning({ id: schema.recordings.id });
  const [tr] = await db
    .insert(schema.transcripts)
    .values({ recordingId: rec.id, provider: "check", status: "ready", text: "x" })
    .returning({ id: schema.transcripts.id });
  const [sp] = await db
    .insert(schema.speakers)
    .values({ recordingId: rec.id, label: "Voice 1", displayName: `Speaker ${key}` })
    .returning({ id: schema.speakers.id });
  await db.insert(schema.segments).values([
    { accountId, recordingId: rec.id, transcriptId: tr.id, speakerId: sp.id, startSec: 0, endSec: 2, text: `hello ${key}`, orderIndex: 0 },
    { accountId, recordingId: rec.id, transcriptId: tr.id, speakerId: sp.id, startSec: 2, endSec: 4, text: `again ${key}`, orderIndex: 1 },
  ]);
  const term = `zq${key}${run}`;
  const [mo] = await db
    .insert(schema.moments)
    .values({
      accountId,
      recordingId: rec.id,
      kind: "observation",
      title: `${term} ${SHARED}`,
      summary: `about ${term}`,
      startSec: 0,
      endSec: 2,
      metadata: { extraction_run: "run1" },
    })
    .returning({ id: schema.moments.id });
  caps[key] = { stem, sourceId, term, rowId: rec.id, momentId: mo.id };
  writeFiles(caps[key]);
}

async function counts(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, col] of [
    ["recordings", "id"],
    ["transcripts", "recording_id"],
    ["segments", "recording_id"],
    ["moments", "recording_id"],
    ["speakers", "recording_id"],
  ] as const) {
    const r = await db.execute(
      sql`select count(*)::int as n from ${sql.raw(table)} where ${sql.raw(col)} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
    );
    out[table] = (r.rows[0] as { n: number }).n;
  }
  return out;
}

async function main(): Promise<void> {
  // ---- files only ---------------------------------------------------------
  writeFileSync(join(dir, "manifest-2026-03-01T10-00-01Z.json"), "{}");
  writeFileSync(join(dir, "mic-2026-03-01T10-00-01Z.wav"), "x");
  writeFileSync(join(dir, "mic-2026-03-01T10-00-02Z.wav"), "x");
  writeFileSync(join(dir, "voice-clip-2026-03-01T10-00-01Z-2-3.wav"), "x");
  writeFileSync(join(dir, "recorder-2026-03-01.log"), "x");
  const one = captureFiles(dir, "2026-03-01T10-00-01Z").sort();
  check(
    "captureFiles takes this capture's files and no other capture's, and not a day's log",
    one.join() === "manifest-2026-03-01T10-00-01Z.json,mic-2026-03-01T10-00-01Z.wav,voice-clip-2026-03-01T10-00-01Z-2-3.wav",
    one.join(),
  );
  for (const f of readdirSync(dir)) rmSync(join(dir, f));
  writeMarker(dir, { stem: "2026-03-01T10-00-01Z", source_id: "s", trashed_at: "2026-03-01T00:00:00.000Z" });
  check(
    "a marker is written whole: read back, listed, and no temp file left",
    isTrashed(dir, "2026-03-01T10-00-01Z") &&
      readMarker(dir, "2026-03-01T10-00-01Z")?.source_id === "s" &&
      trashedStems(dir).join() === "2026-03-01T10-00-01Z" &&
      !existsSync(markerPath(dir, "2026-03-01T10-00-01Z") + ".tmp"),
  );
  rmSync(markerPath(dir, "2026-03-01T10-00-01Z"));

  // ---- throwaway account and rows ----------------------------------------
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: `check-trash ${run}`, slug: `check-trash-${run}` })
    .returning({ id: schema.accounts.id });
  const acc = account.id;
  const [member] = await db
    .insert(schema.accountMembers)
    .values({ accountId: acc, email: `owner-${run}@check-trash.test`, role: "admin" })
    .returning({ id: schema.accountMembers.id, email: schema.accountMembers.email });
  ownerMemberId = member.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.access = { accountId: acc, memberId: member.id, role: "admin", authUserId: "check-trash", email: member.email, scope: [] };
    next();
  });
  app.use("/accounts/:accountId/recordings", recordingsRouter);
  app.use("/accounts/:accountId/moments", momentsRouter);
  app.use("/", transcriptRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  };
  const search = async (term: string): Promise<string[]> =>
    ((await get(`/accounts/${acc}/moments?q=${term}&limit=50`)).body.moments ?? []).map((m: any) => m.recordingId);
  const semanticStatus = async (): Promise<number> =>
    (await get(`/accounts/${acc}/moments?semantic_q=nothing&limit=5`)).status;
  const indexIds = async (): Promise<string[]> =>
    ((await get(`/accounts/${acc}/moments?index=true&limit=50`)).body.recordings ?? []).map((r: any) => r.id);
  const rowsOfThisRun = async (): Promise<number> =>
    (await db.select({ id: schema.recordings.id }).from(schema.recordings).where(like(schema.recordings.sourceId, `${ROW_PREFIX}%`))).length;

  try {
    await makeRow(acc, "a", 1, TERMINAL_STATUS);
    await makeRow(acc, "b", 2, TERMINAL_STATUS);
    await makeRow(acc, "c", 3, TERMINAL_STATUS);
    const A = caps.a, B = caps.b, C = caps.c;

    // ---- positive control: everything is found before anything is trashed --
    check("before trash: search finds a by its own term", (await search(A.term)).join() === A.rowId, String(await search(A.term)));
    check("before trash: the shared term finds all three", (await search(SHARED)).length === 3);
    check("before trash: get_transcript finds a", (await get(`/recordings/${A.rowId}/transcript`)).status === 200);
    check("before trash: a moment by id is found", (await get(`/accounts/${acc}/moments/${A.momentId}`)).status === 200);
    check("before trash: the index lists a", (await indexIds()).includes(A.rowId));
    check("before trash: the recording list and GET /:id find a",
      (await get(`/accounts/${acc}/recordings`)).body.recordings.some((r: any) => r.id === A.rowId) &&
        (await get(`/accounts/${acc}/recordings/${A.rowId}`)).status === 200);
    check("the semantic branch runs (200) with the new condition in its SQL", (await semanticStatus()) === 200, String(await semanticStatus()));

    // ---- trash ---------------------------------------------------------------
    const t = await trashCapture(dir, A.stem);
    const [rowA] = await db.select({ t: schema.recordings.trashedAt }).from(schema.recordings).where(eq(schema.recordings.id, A.rowId));
    check("trash: marker written, one row marked", isTrashed(dir, A.stem) && t.rows === 1 && rowA.t !== null);
    check("trash: search by a's own term finds nothing", (await search(A.term)).length === 0);
    check("trash: the shared term finds b and c but not a", (await search(SHARED)).sort().join() === [B.rowId, C.rowId].sort().join());
    check("trash: get_transcript is a 404", (await get(`/recordings/${A.rowId}/transcript`)).status === 404);
    check("trash: a moment by id is a 404", (await get(`/accounts/${acc}/moments/${A.momentId}`)).status === 404);
    check("trash: the index omits a and keeps b and c", !(await indexIds()).includes(A.rowId) && (await indexIds()).includes(B.rowId) && (await indexIds()).includes(C.rowId));
    check("trash: the recording list and GET /:id omit a",
      !(await get(`/accounts/${acc}/recordings`)).body.recordings.some((r: any) => r.id === A.rowId) &&
        (await get(`/accounts/${acc}/recordings/${A.rowId}`)).status === 404);
    const saved = spawnSync("npx", ["tsx", "src/pipeline/save-transcript.ts", "--recording", A.rowId, "--out", join(dir, "out.txt")], { encoding: "utf8" });
    check("trash: Save transcript's script refuses a trashed recording", saved.status !== 0 && /not found/.test(saved.stderr), `${saved.status} ${saved.stderr}`);
    check("trash: the semantic branch still runs", (await semanticStatus()) === 200);

    // ---- restore -------------------------------------------------------------
    await restoreCapture(dir, A.stem);
    check("restore: marker gone, column cleared", !isTrashed(dir, A.stem) && (await db.select({ t: schema.recordings.trashedAt }).from(schema.recordings).where(eq(schema.recordings.id, A.rowId)))[0].t === null);
    check("restore: search, transcript, moment, index and list all find a again",
      (await search(A.term)).join() === A.rowId &&
        (await get(`/recordings/${A.rowId}/transcript`)).status === 200 &&
        (await get(`/accounts/${acc}/moments/${A.momentId}`)).status === 200 &&
        (await indexIds()).includes(A.rowId) &&
        (await get(`/accounts/${acc}/recordings/${A.rowId}`)).status === 200);

    // ---- the database is unreachable: refuse, leave nothing -----------------
    const offline = spawnSync("npx", ["tsx", "src/pipeline/trash.ts", dir, "trash", "--stem", B.stem], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" },
    });
    const line = (offline.stdout.split("\n").find((l) => l.startsWith("TRASH_RESULT ")) ?? "").slice("TRASH_RESULT ".length);
    const res = line ? JSON.parse(line) : null;
    check("offline: trash fails with db_unreachable and exit 1", offline.status === 1 && res?.ok === false && res?.code === "db_unreachable", offline.stdout + offline.stderr);
    check("offline: the marker was removed, nothing moved to trash", !isTrashed(dir, B.stem));
    check("offline: b is still found", (await search(B.term)).join() === B.rowId);

    // ---- reconcile: the marker is the intent, the column follows ------------
    writeMarker(dir, { stem: B.stem, source_id: B.sourceId, trashed_at: new Date().toISOString() });
    check("crash between marker and column: b is still found (they disagree)", (await search(B.term)).length === 1);
    const r1 = await reconcileTrash(dir);
    check("reconcile: marker present -> column set, b hidden", r1.marked >= 1 && (await search(B.term)).length === 0);
    rmSync(markerPath(dir, B.stem));
    const r2 = await reconcileTrash(dir);
    check("reconcile: marker gone -> column cleared, b found again", r2.cleared >= 1 && (await search(B.term)).join() === B.rowId);

    // ---- recovery skips a trashed capture ------------------------------------
    // d and e are unfinished (status pending): an untrashed one is work for
    // recovery. Real passes below run only while both are trashed.
    await makeRow(acc, "d", 4, "pending");
    await makeRow(acc, "e", 5, "pending");
    const D = caps.d, E = caps.e;
    const dry = await runRecoveryPass({ dir, dryRun: true });
    const dryStems = dry.processing.map((o) => o.stem);
    check("positive control: unfinished, untrashed captures are picked up by recovery (dry run)", dryStems.includes(D.stem) && dryStems.includes(E.stem), dryStems.join());
    await trashCapture(dir, D.stem);
    await trashCapture(dir, E.stem);
    await trashCapture(dir, C.stem);
    const pass = await runRecoveryPass({ dir });
    const passStems = pass.processing.map((o) => o.stem);
    check("recovery: trashed captures (complete or not) are not in the pass at all", ![C.stem, D.stem, E.stem].some((s) => passStems.includes(s)), passStems.join());
    check("recovery: a complete, untrashed capture is still reported", passStems.includes(A.stem) && passStems.includes(B.stem), passStems.join());
    check("recovery: a trashed unfinished capture got no attempt file", !existsSync(join(dir, `recovery-${D.stem}.json`)));
    const dry2 = await runRecoveryPass({ dir, dryRun: true });
    check("recovery: still skipped on a second pass", ![C.stem, D.stem, E.stem].some((s) => dry2.processing.map((o) => o.stem).includes(s)));
    await restoreCapture(dir, D.stem);
    await restoreCapture(dir, E.stem);
    await restoreCapture(dir, C.stem);
    const dry3 = await runRecoveryPass({ dir, dryRun: true });
    check("restore puts an unfinished capture back in recovery's sight (dry run)", dry3.processing.map((o) => o.stem).includes(D.stem));
    // Back in the trash before any further real pass: a real pass over an
    // unfinished, untrashed capture would start a pipeline on made-up files.
    await trashCapture(dir, D.stem);
    await trashCapture(dir, E.stem);

    // ---- permanent delete ----------------------------------------------------
    let refused: unknown = null;
    try {
      await deleteCapture(dir, C.stem);
    } catch (e) {
      refused = e;
    }
    check("delete refuses a capture that is not in the trash, and removes nothing",
      refused instanceof TrashError && refused.code === "not_trashed" && captureFiles(dir, C.stem).length === FILES_PER_CAPTURE && (await counts([C.rowId])).recordings === 1,
      String(refused));
    const before = await counts([A.rowId, B.rowId]);
    check("before delete: a and b have rows, transcripts, segments, moments, speakers",
      before.recordings === 2 && before.transcripts === 2 && before.segments === 4 && before.moments === 2 && before.speakers === 2, JSON.stringify(before));

    await trashCapture(dir, A.stem);
    await trashCapture(dir, B.stem);
    const out = execFileSync("npx", ["tsx", "src/pipeline/trash.ts", dir, "delete", "--stem", A.stem, "--stem", B.stem], { encoding: "utf8" });
    const results = out.split("\n").filter((l) => l.startsWith("TRASH_RESULT ")).map((l) => JSON.parse(l.slice("TRASH_RESULT ".length)));
    check("delete two in one action: both report ok, one row each", results.length === 2 && results.every((r) => r.ok && r.rowsDeleted === 1), out);
    const after = await counts([A.rowId, B.rowId]);
    check("delete: rows, transcripts, segments, moments and speakers are all gone (counted directly)", Object.values(after).every((n) => n === 0), JSON.stringify(after));
    check("delete: no capture files and no marker remain for a or b", captureFiles(dir, A.stem).length === 0 && captureFiles(dir, B.stem).length === 0);
    const orphans = await db.execute(sql`
      select
        (select count(*)::int from transcripts t left join recordings r on r.id = t.recording_id where r.id is null) as orphan_transcripts,
        (select count(*)::int from moments m left join recordings r on r.id = m.recording_id where r.id is null) as orphan_moments`);
    const o = orphans.rows[0] as { orphan_transcripts: number; orphan_moments: number };
    check("delete: no orphan transcripts or moments anywhere", o.orphan_transcripts === 0 && o.orphan_moments === 0, JSON.stringify(o));
    check("delete: search no longer reaches a or b", (await search(A.term)).length === 0 && (await search(B.term)).length === 0);

    // ---- the neighbour is untouched ------------------------------------------
    const cc = await counts([C.rowId]);
    check("blast radius: c's row, transcript, segments, moment and speaker are intact", cc.recordings === 1 && cc.transcripts === 1 && cc.segments === 2 && cc.moments === 1 && cc.speakers === 1, JSON.stringify(cc));
    check("blast radius: c's files are intact", captureFiles(dir, C.stem).length === FILES_PER_CAPTURE, String(captureFiles(dir, C.stem).length));
    check("blast radius: search still finds c", (await search(C.term)).join() === C.rowId && (await search(SHARED)).includes(C.rowId));

    // ---- stays gone after a "relaunch" ---------------------------------------
    // c was restored above and is complete; d and e are trashed again. No
    // unfinished, untrashed capture exists, so this real pass has nothing to
    // run — and the assertions below prove it started nothing.
    const rowsBefore = await rowsOfThisRun();
    const relaunch = await runRecoveryPass({ dir });
    const relaunchStems = relaunch.processing.map((p) => p.stem);
    const back = await db.select({ id: schema.recordings.id }).from(schema.recordings).where(inArray(schema.recordings.sourceId, [A.sourceId, B.sourceId]));
    check("relaunch: recovery's pass does not mention a or b, and no row for either came back",
      ![A.stem, B.stem].some((s) => relaunchStems.includes(s)) && back.length === 0, `${back.length} rows`);
    check("relaunch: the pass started no pipeline (every outcome is 'complete')",
      relaunch.processing.length > 0 && relaunch.processing.every((p) => p.action === "complete"),
      JSON.stringify(relaunch.processing.map((p) => [p.stem, p.action])));
    check("relaunch: no attempt file was written for any capture",
      readdirSync(dir).filter((f) => f.startsWith("recovery-")).length === 0, readdirSync(dir).filter((f) => f.startsWith("recovery-")).join());
    check("relaunch: no pipeline sidecar or transcript was created or changed beyond the made-up ones",
      readdirSync(dir).filter((f) => f.startsWith("pipeline-")).length === 3, readdirSync(dir).filter((f) => f.startsWith("pipeline-")).join());
    check("relaunch: no row appeared for this run (the count of this run's rows is unchanged)", (await rowsOfThisRun()) === rowsBefore, `${rowsBefore} -> ${await rowsOfThisRun()}`);

    // Positive control for the 09-20 failure: a row deleted but files left
    // behind IS seen by recovery as work. This is what the order prevents.
    // Dry run only: a real pass would re-ingest the made-up files.
    await makeRow(acc, "r", 6, TERMINAL_STATUS);
    const R = caps.r;
    await db.delete(schema.recordings).where(eq(schema.recordings.id, R.rowId));
    const resurrect = await runRecoveryPass({ dir, dryRun: true });
    check("positive control: a row deleted while its files remain is picked up to be re-ingested (09-20)",
      resurrect.processing.some((p) => p.stem === R.stem && p.action === "skipped"), JSON.stringify(resurrect.processing.map((p) => [p.stem, p.action])));
    for (const f of captureFiles(dir, R.stem)) rmSync(join(dir, f));

    // ---- a crash partway through a delete ------------------------------------
    await makeRow(acc, "x", 7, TERMINAL_STATUS);
    const X = caps.x;
    await trashCapture(dir, X.stem);
    for (const f of captureFiles(dir, X.stem)) if (f !== `trashed-${X.stem}.json`) rmSync(join(dir, f)); // files and manifest gone, row and marker remain
    await reconcileTrash(dir);
    check("crash mid-delete: still trashed and hidden from search", isTrashed(dir, X.stem) && (await search(X.term)).length === 0);
    const gone = await deleteCapture(dir, X.stem);
    check("crash mid-delete: deleting again finishes it (row gone, marker gone)", gone.rowsDeleted === 1 && !isTrashed(dir, X.stem) && (await counts([X.rowId])).recordings === 0, JSON.stringify(gone));
  } finally {
    // Recordings first: owner_member_id restricts deleting a member that still
    // owns one, and the account's cascade does not promise an order.
    await db.delete(schema.recordings).where(like(schema.recordings.sourceId, `${ROW_PREFIX}%`));
    await db.delete(schema.accounts).where(eq(schema.accounts.id, acc));
    const left = await db.select({ id: schema.recordings.id }).from(schema.recordings).where(like(schema.recordings.sourceId, `${ROW_PREFIX}%`));
    check("cleanup: the throwaway account and every row of this run are gone", left.length === 0, `${left.length} rows left`);
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
