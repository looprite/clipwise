// Regression check for trash, restore and permanent delete (SAA-154): the trash
// marker's file handling (lib/trash-marker.ts), what the routers hide while a
// recording is trashed, and what a permanent delete takes with it. Trash state is
// set on the column directly; the server's capture-scope routes that set it for
// the recorder are check-access 18d and 18e (SAA-227). The cases for the direct
// path's trash, recovery and save-transcript scripts went with those scripts.
//
// Files are made-up captures in a temporary folder, never the live recordings
// folder. Rows are throwaway, in a throwaway account that is deleted at the end,
// so Claude's real account never sees them. The real routers (moments,
// transcript, recordings) are mounted in-process and called over HTTP, so a
// missing join or a wrong filter fails here rather than on a live search.
//
// Usage:
//   tsx src/pipeline/check-trash.ts

import express from "express";
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
const FILES_PER_CAPTURE = 7;

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
  const setTrashed = async (rowId: string, at: Date | null): Promise<void> => {
    await db.update(schema.recordings).set({ trashedAt: at }).where(eq(schema.recordings.id, rowId));
  };

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
    // The column is what the routers read. The recorder sets it through the
    // server's capture-scope route (check-access 18d and 18e); here it is set
    // directly, so these cases test only what the routers hide.
    await setTrashed(A.rowId, new Date());
    check("trash: search by a's own term finds nothing", (await search(A.term)).length === 0);
    check("trash: the shared term finds b and c but not a", (await search(SHARED)).sort().join() === [B.rowId, C.rowId].sort().join());
    check("trash: get_transcript is a 404", (await get(`/recordings/${A.rowId}/transcript`)).status === 404);
    check("trash: a moment by id is a 404", (await get(`/accounts/${acc}/moments/${A.momentId}`)).status === 404);
    check("trash: the index omits a and keeps b and c", !(await indexIds()).includes(A.rowId) && (await indexIds()).includes(B.rowId) && (await indexIds()).includes(C.rowId));
    check("trash: the recording list and GET /:id omit a",
      !(await get(`/accounts/${acc}/recordings`)).body.recordings.some((r: any) => r.id === A.rowId) &&
        (await get(`/accounts/${acc}/recordings/${A.rowId}`)).status === 404);
    check("trash: the semantic branch still runs", (await semanticStatus()) === 200);

    // ---- restore -------------------------------------------------------------
    await setTrashed(A.rowId, null);
    check("restore: search, transcript, moment, index and list all find a again",
      (await search(A.term)).join() === A.rowId &&
        (await get(`/recordings/${A.rowId}/transcript`)).status === 200 &&
        (await get(`/accounts/${acc}/moments/${A.momentId}`)).status === 200 &&
        (await indexIds()).includes(A.rowId) &&
        (await get(`/accounts/${acc}/recordings/${A.rowId}`)).status === 200);

    // ---- permanent delete ----------------------------------------------------
    // Only from the trash, as the server's DELETE route does; the row is deleted
    // directly and everything under it must go with it.
    const before = await counts([A.rowId, B.rowId]);
    check("before delete: a and b have rows, transcripts, segments, moments, speakers",
      before.recordings === 2 && before.transcripts === 2 && before.segments === 4 && before.moments === 2 && before.speakers === 2, JSON.stringify(before));
    await setTrashed(A.rowId, new Date());
    await setTrashed(B.rowId, new Date());
    await db.delete(schema.recordings).where(inArray(schema.recordings.id, [A.rowId, B.rowId]));
    const after = await counts([A.rowId, B.rowId]);
    check("delete: rows, transcripts, segments, moments and speakers are all gone (counted directly)", Object.values(after).every((n) => n === 0), JSON.stringify(after));
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
