// Check that call text is encrypted at rest (SAA-277 step 2). Writes a recording
// whose every call-text field carries one phrase, then:
//
//   - a raw SQL search for the phrase, column by column, finds nothing;
//   - control: the same raw search finds it in an attendee name, which by decision
//     stays plain (so the search can find the phrase when it is there);
//   - the phrase comes back through the server's own reads: readTranscript,
//     getTranscriptPage (what get_transcript returns) and getMoment;
//   - the metadata keys that searches filter on are still readable by SQL;
//   - a capture posted through POST /captures (the recorder's path) is stored,
//     raw SQL finds its phrase in no segment and its dropped line nowhere in the
//     metadata, and getTranscriptPage shows the phrase.
//
// Writes, so it refuses unless run through scratch-db.sh on a scratch branch:
//
//   scripts/scratch-db.sh run check-call-text-at-rest
//
// Everything it wrote goes with its throwaway account at the end.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import type { AccessContext } from "../access/context.js";
import { capturesPost } from "../routes/captures.js";
import { isEncryptedCallText } from "../lib/call-text.js";
import { readTranscript } from "../lib/transcript-read.js";
import { getMoment } from "../services/search-moments.js";
import { getTranscriptPage } from "../services/transcript.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { db, pool, schema } from "./index.js";

// capturesPost through a request that carries only what it reads (access, body)
// and a response that records the status and body. An error it passes to next()
// is reported by its class and message, which name counts and codes, never text.
async function postCapture(ctx: AccessContext, body: unknown): Promise<{ status: number; body: unknown; error?: string }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      status(s: number) {
        status = s;
        return res;
      },
      json(b: unknown) {
        resolve({ status, body: b });
        return res;
      },
    };
    const next = (err?: unknown) => {
      const e = err as { status?: number; code?: string; message?: string } | undefined;
      resolve({ status: e?.status ?? 500, body: null, error: `${e?.code ?? (err instanceof Error ? err.name : "error")}: ${e?.message ?? String(err)}` });
    };
    capturesPost({ access: ctx, body } as unknown as Request, res as unknown as Response, next as NextFunction);
  });
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

await refuseUnlessScratch("check-call-text-at-rest");
if (!process.env.CALL_TEXT_KEY) {
  process.stderr.write("check-call-text-at-rest: CALL_TEXT_KEY is not set (scratch-db.sh passes the branch's test key)\n");
  process.exit(2);
}

let fx: Fixture | null = null;
try {
  fx = await makeAccount("check-call-text");
  const PHRASE = `zebra${fx.tag}lantern`;
  const RUN = randomUUID();
  const rid = randomUUID();

  await db.insert(schema.recordings).values({
    id: rid,
    accountId: fx.accountId,
    ownerMemberId: fx.memberId,
    slug: `check-call-text-${fx.tag}`,
    title: `Budget review ${PHRASE}`,
    source: "check",
    sourceId: rid,
    status: "ready",
    visibility: "private",
    metadata: {
      current_extraction_run: RUN,
      capture: { stem: "2026-11-08-1000" },
      capture_quality: { verdict: "partial", dropped_segments: [{ track: "them", start_ms: 0, end_ms: 900, text: `dropped ${PHRASE} speech` }] },
    },
  });
  const [transcript] = await db
    .insert(schema.transcripts)
    .values({ recordingId: rid, provider: "check", language: "en", text: `whole ${PHRASE} transcript`, status: "ready" })
    .returning();
  const [me] = await db.insert(schema.speakers).values({ recordingId: rid, label: "me" }).returning();
  await db.insert(schema.segments).values([
    { accountId: fx.accountId, recordingId: rid, transcriptId: transcript.id, speakerId: me.id, startSec: 0, endSec: 4, text: `so the ${PHRASE} line is final`, orderIndex: 0 },
    { accountId: fx.accountId, recordingId: rid, transcriptId: transcript.id, speakerId: me.id, startSec: 5, endSec: 9, text: "agreed", orderIndex: 1 },
  ]);
  const [moment] = await db
    .insert(schema.moments)
    .values({
      accountId: fx.accountId,
      recordingId: rid,
      kind: "decision",
      title: `Keep the ${PHRASE} line`,
      summary: `The group kept the ${PHRASE} line as it was.`,
      startSec: 0,
      endSec: 4,
      metadata: { source: "extracted", extraction_run: RUN, span_label: `${PHRASE} topic`, speakers: [`Guest ${PHRASE}`], span_segment_range: [0, 1] },
    })
    .returning({ id: schema.moments.id });
  await db.insert(schema.clips).values({ accountId: fx.accountId, recordingId: rid, title: `clip ${PHRASE}`, description: `about ${PHRASE}`, startSec: 0, endSec: 4 });
  await db.insert(schema.attendees).values({ recordingId: rid, name: `Guest ${PHRASE}`, isHost: false });

  // ---- what the database holds, read without the server ----
  const like = `%${PHRASE}%`;
  const columns: Array<[string, string]> = [
    ["recordings.title", `select count(*)::int n from recordings where id = $1 and title ilike $2`],
    ["recordings.metadata", `select count(*)::int n from recordings where id = $1 and metadata::text ilike $2`],
    ["transcripts.text", `select count(*)::int n from transcripts where recording_id = $1 and text ilike $2`],
    ["segments.text", `select count(*)::int n from segments where recording_id = $1 and text ilike $2`],
    ["moments.title", `select count(*)::int n from moments where recording_id = $1 and title ilike $2`],
    ["moments.summary", `select count(*)::int n from moments where recording_id = $1 and summary ilike $2`],
    ["moments.metadata", `select count(*)::int n from moments where recording_id = $1 and metadata::text ilike $2`],
    ["clips.title", `select count(*)::int n from clips where recording_id = $1 and title ilike $2`],
    ["clips.description", `select count(*)::int n from clips where recording_id = $1 and description ilike $2`],
  ];
  for (const [name, q] of columns) {
    const n = (await pool.query(q, [rid, like])).rows[0].n as number;
    check(`raw SQL finds the phrase nowhere in ${name}`, n === 0, `found in ${n} row(s)`);
  }
  const plainName = (await pool.query(`select count(*)::int n from attendees where recording_id = $1 and name ilike $2`, [rid, like])).rows[0].n as number;
  check("control: the same raw search finds the phrase in an attendee name (plain by decision)", plainName === 1, `found in ${plainName} row(s)`);
  const shapes = (await pool.query(`select text from segments where recording_id = $1`, [rid])).rows.map((r) => r.text as string);
  check("every stored segment is in the encrypted shape", shapes.length === 2 && shapes.every(isEncryptedCallText), shapes.map((s) => s.slice(0, 14)).join(", "));

  // ---- the metadata keys searches filter on ----
  const filterable = (await pool.query(
    `select count(*)::int n from moments m join recordings r on r.id = m.recording_id
      where m.recording_id = $1 and m.metadata->>'source' = 'extracted' and (m.metadata->>'extraction_run') = (r.metadata->>'current_extraction_run')
        and (m.metadata->>'collapsed_into') is null`,
    [rid],
  )).rows[0].n as number;
  check("the moment's source, extraction_run and collapsed_into are still filterable in SQL", filterable === 1, `matched ${filterable}`);
  const stem = (await pool.query(`select metadata->'capture'->>'stem' s from recordings where id = $1`, [rid])).rows[0].s as string | null;
  check("the recording's capture stem is still readable in SQL", stem === "2026-11-08-1000", String(stem));

  // ---- what the server reads back ----
  const ctx: AccessContext = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check-call-text", email: `check-call-text-${fx.tag}@clipwise.test`, scope: [] };
  const read = await readTranscript(rid);
  check("readTranscript gives the segment text back", read.segments.some((s) => s.text === `so the ${PHRASE} line is final`));
  const page = await getTranscriptPage(ctx, rid, {});
  check("getTranscriptPage (get_transcript) shows the phrase", page.page.text.includes(PHRASE));
  check("getTranscriptPage gives the recording title back", page.title === `Budget review ${PHRASE}`, String(page.title));
  const got = (await getMoment(ctx, moment.id)).moment;
  const meta = got.metadata as { span_label?: unknown; speakers?: unknown } | null;
  check("getMoment gives the title and summary back", got.title === `Keep the ${PHRASE} line` && got.summary === `The group kept the ${PHRASE} line as it was.`);
  check("getMoment gives the topic tag and the speakers back, open", meta?.span_label === `${PHRASE} topic` && JSON.stringify(meta?.speakers) === JSON.stringify([`Guest ${PHRASE}`]), JSON.stringify(meta));
  const [rec] = await db.select({ metadata: schema.recordings.metadata }).from(schema.recordings).where(eq(schema.recordings.id, rid));
  const droppedText = (rec.metadata as { capture_quality?: { dropped_segments?: Array<{ text: string }> } }).capture_quality?.dropped_segments?.[0]?.text;
  check("the dropped speech reads back open through the server", droppedText === `dropped ${PHRASE} speech`, String(droppedText));
  const [tr] = await db.select({ text: schema.transcripts.text }).from(schema.transcripts).where(eq(schema.transcripts.recordingId, rid));
  check("transcripts.text reads back open", tr.text === `whole ${PHRASE} transcript`);

  // ---- the recorder's path: POST /captures ----
  // The real handler (routes/captures.ts capturesPost), called with the member's
  // access context and a capture body; it reads nothing else of the request. One
  // `me` line is kept, and one `them` line is excluded by the classification, so
  // it lands in the recording's metadata as dropped speech.
  const CAP = `heron${fx.tag}compass`;
  const segs = [
    { track: "me" as const, startMs: 0, endMs: 3000, text: `we sign the ${CAP} deal on friday` },
    { track: "them" as const, startMs: 3500, endMs: 6000, text: `the ${CAP} line, dropped` },
  ];
  const body = {
    captureId: randomUUID().toUpperCase(),
    startedAt: new Date().toISOString(),
    stem: `check-call-text-${fx.tag}`,
    engine: "parakeet",
    model: "check",
    segments: segs,
    sourceFidelity: { declaredTurnCount: segs.length, declaredBodyChars: segs.reduce((n, s) => n + s.text.length, 0), countedFrom: "check-call-text-at-rest" },
    classification: { verdict: "partial", concern: false, reason: "check: them excluded", excludedLabels: ["them"] },
    capture: { permissions: {}, triggerApp: null },
  };
  const reply = await postCapture(ctx, body);
  check("POST /captures stores the capture (201)", reply.status === 201, `status ${reply.status}: ${reply.error ?? JSON.stringify(reply.body)}`);
  const capRid = (reply.body as { recordingId?: string } | null)?.recordingId;
  if (reply.status === 201 && capRid) {
    const capLike = `%${CAP}%`;
    const inSegments = (await pool.query(`select count(*)::int n from segments where recording_id = $1 and text ilike $2`, [capRid, capLike])).rows[0].n as number;
    check("captured: raw SQL finds the phrase in no segment", inSegments === 0, `found in ${inSegments} row(s)`);
    const inMeta = (await pool.query(`select count(*)::int n from recordings where id = $1 and metadata::text ilike $2`, [capRid, capLike])).rows[0].n as number;
    check("captured: raw SQL finds the dropped line nowhere in the recording's metadata", inMeta === 0, `found in ${inMeta} row(s)`);
    const capPage = await getTranscriptPage(ctx, capRid, {});
    check("captured: getTranscriptPage (get_transcript) shows the phrase", capPage.page.text.includes(`we sign the ${CAP} deal on friday`), capPage.page.text.slice(0, 200));
    const [capRec] = await db.select({ metadata: schema.recordings.metadata }).from(schema.recordings).where(eq(schema.recordings.id, capRid));
    const capDropped = (capRec.metadata as { capture_quality?: { dropped_segments?: Array<{ text: string }> } }).capture_quality?.dropped_segments?.[0]?.text;
    check("captured: the dropped line reads back open through the server", capDropped === `the ${CAP} line, dropped`, String(capDropped));
  }
} finally {
  if (fx) await dropAccount(fx);
  await endPool();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
