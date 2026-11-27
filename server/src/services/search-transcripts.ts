// Word search over transcript lines (11-27, Jon): the MCP tool search_transcripts.
//
// Which calls: the calls search_moments searches. recordingVisibleTo, not
// trashed, the same personal/work default (search-moments.ts:323-345: "work"
// when scope is omitted, an unlabelled call counted as work) and the same date
// bounds (pushDateRangeConditions). A recordingId the caller can't see, or that
// doesn't exist, is the same 404 get_transcript gives, so the answer doesn't
// say which.
//
// Which lines: each call's transcript as get_transcript reads it (its first
// transcript, segments by order_index; lib/transcript-read.ts) and renders it
// (transcriptLines: the same numbering, the same speaker names, an empty line
// numbered but not shown). A hit is a shown line holding every word of the
// query, ignoring case, in what was said; speaker names aren't searched.
//
// Call text is encrypted at rest, so SQL sees only ciphertext: every line of
// every call in scope is read and decrypted here on each query, as lexical
// search_moments does with moments (search-moments.ts:486-503). recordingId,
// dates and scope narrow the read too.
//
// Order: search_moments' round-robin (SAA-108). Every call's first hit comes
// before any call's second, newest call first at each depth, so a list cut by
// `limit` still spans calls.

import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AccessContext } from "../access/context.js";
import { recordingVisibleTo } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { micSharedIn } from "../ingest/identity.js";
import { HttpError } from "../lib/http.js";
import { UNATTRIBUTED, displayTitle, formatTimestamp, type FileSegment } from "../lib/transcript-file.js";
import { pushDateRangeConditions } from "./search-moments.js";
import { transcriptLines } from "./transcript-page.js";

export const searchTranscriptsQuerySchema = z.object({
  query: z.string().max(512),
  recordingId: z.string().uuid().optional(),
  scope: z.enum(["work", "personal", "all"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type SearchTranscriptsQuery = z.infer<typeof searchTranscriptsQuerySchema>;

export type TranscriptHit = {
  recordingId: string;
  recordingTitle: string;
  startedAt: string | null;
  segment: number;
  time: string;
  startSec: number;
  speaker: string;
  line: string;
  before: string[];
  after: string[];
};

const r = schema.recordings;

export async function searchTranscripts(ctx: AccessContext, query: SearchTranscriptsQuery) {
  const words = query.query.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length === 0) throw new HttpError(400, "query_has_no_words");
  const resolvedScope = query.scope ?? "work";
  const scopeDefaulted = query.scope === undefined;
  const limit = query.limit ?? 50;

  // Asked for one call: it must be one the caller can see, whatever the scope,
  // or it's the same "not found" as a call that isn't there.
  if (query.recordingId) {
    const [seen] = await db
      .select({ id: r.id })
      .from(r)
      .where(and(eq(r.id, query.recordingId), isNull(r.trashedAt), recordingVisibleTo(ctx)));
    if (!seen) throw new HttpError(404, "recording_not_found");
  }

  const conditions: (SQL | undefined)[] = [recordingVisibleTo(ctx), isNull(r.trashedAt)];
  if (query.recordingId) conditions.push(eq(r.id, query.recordingId));
  pushDateRangeConditions(conditions, query);
  if (resolvedScope === "work") conditions.push(or(isNull(r.scope), eq(r.scope, "work")));
  else if (resolvedScope === "personal") conditions.push(eq(r.scope, "personal"));

  const empty = { hits: [] as TranscriptHit[], totalMatches: 0, truncated: false, scope: resolvedScope, scopeDefaulted };
  const recordings = await db
    .select({ id: r.id, title: r.title, startedAt: r.startedAt, metadata: r.metadata })
    .from(r)
    .where(and(...conditions));
  if (recordings.length === 0) return empty;
  const ids = recordings.map((x) => x.id);

  // The host attendee's name, for a `me` row with no name of its own, as
  // getTranscriptPage finds it.
  const hosts = new Map<string, string | null>();
  const hostRows = await db
    .select({ recordingId: schema.attendees.recordingId, name: schema.attendees.name })
    .from(schema.attendees)
    .where(and(inArray(schema.attendees.recordingId, ids), eq(schema.attendees.isHost, true)));
  for (const a of hostRows) if (!hosts.has(a.recordingId)) hosts.set(a.recordingId, a.name);

  // Each call's first transcript, as readTranscript picks it.
  const firstTranscript = new Map<string, string>();
  const transcriptRows = await db
    .select({ id: schema.transcripts.id, recordingId: schema.transcripts.recordingId })
    .from(schema.transcripts)
    .where(inArray(schema.transcripts.recordingId, ids))
    .orderBy(asc(schema.transcripts.createdAt));
  for (const t of transcriptRows) if (!firstTranscript.has(t.recordingId)) firstTranscript.set(t.recordingId, t.id);
  if (firstTranscript.size === 0) return empty;

  const segmentRows = await db
    .select({
      transcriptId: schema.segments.transcriptId,
      startSec: schema.segments.startSec,
      endSec: schema.segments.endSec,
      text: schema.segments.text,
      speakerLabel: schema.speakers.label,
      speakerDisplayName: schema.speakers.displayName,
    })
    .from(schema.segments)
    .leftJoin(schema.speakers, eq(schema.segments.speakerId, schema.speakers.id))
    .where(inArray(schema.segments.transcriptId, [...firstTranscript.values()]))
    .orderBy(asc(schema.segments.transcriptId), asc(schema.segments.orderIndex));
  const byTranscript = new Map<string, FileSegment[]>();
  for (const s of segmentRows) {
    const list = byTranscript.get(s.transcriptId) ?? [];
    list.push({ startSec: s.startSec, endSec: s.endSec, text: s.text, speakerLabel: s.speakerLabel ?? null, speakerDisplayName: s.speakerDisplayName ?? null });
    byTranscript.set(s.transcriptId, list);
  }

  const matches: Array<TranscriptHit & { rank: number; startedMs: number }> = [];
  for (const rec of recordings) {
    const segs = byTranscript.get(firstTranscript.get(rec.id) ?? "") ?? [];
    if (segs.length === 0) continue;
    const { names, texts, lines } = transcriptLines(segs, hosts.get(rec.id) ?? null, micSharedIn(rec.metadata));
    const shown = lines.flatMap((l, i) => (l === null ? [] : [i]));
    let rank = 0;
    shown.forEach((i, k) => {
      const said = texts[i].toLowerCase();
      if (!words.every((w) => said.includes(w))) return;
      matches.push({
        recordingId: rec.id,
        recordingTitle: displayTitle(rec.title),
        startedAt: rec.startedAt ? rec.startedAt.toISOString() : null,
        segment: i,
        time: formatTimestamp(segs[i].startSec),
        startSec: segs[i].startSec,
        speaker: names.get(segs[i].speakerLabel) ?? UNATTRIBUTED,
        line: lines[i]!,
        before: shown.slice(Math.max(0, k - 2), k).map((j) => lines[j]!),
        after: shown.slice(k + 1, k + 3).map((j) => lines[j]!),
        rank: ++rank,
        // desc(started_at) as Postgres sorts it: nulls first.
        startedMs: rec.startedAt ? rec.startedAt.getTime() : Number.POSITIVE_INFINITY,
      });
    });
  }
  matches.sort(
    (a, b) => a.rank - b.rank || b.startedMs - a.startedMs || a.recordingId.localeCompare(b.recordingId) || a.segment - b.segment,
  );
  const hits = matches.slice(0, limit).map(({ rank: _rank, startedMs: _startedMs, ...hit }) => hit);
  return { hits, totalMatches: matches.length, truncated: matches.length > hits.length, scope: resolvedScope, scopeDefaulted };
}
