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
//
// By meaning (SAA-370 step 2): `semanticQuery` instead of `query`, exactly one of
// the two. The same calls (the same conditions, built once below), then the
// transcript windows of those calls (transcript_windows, jobs/embed-lines.ts),
// nearest first by cosine distance to the query's vector (input_type "query";
// Decision 13). A window that overlaps a nearer kept one of the same call is
// dropped, so overlap doesn't fill the page. Each hit is the window's lines
// exactly as get_transcript prints them now (current names). The answer says
// how many calls in scope have windows (callsSearched) and how many don't yet
// (callsNotYetSearchable), since a call not yet embedded is not an absence.
// HNSW with iterative scan in strict order, so filtering to the caller's calls
// can't leave a short page (pgvector 0.8; ef_search alone caps a scan).

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions/vector";
import { z } from "zod";
import type { AccessContext } from "../access/context.js";
import { recordingVisibleTo } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { micSharedIn } from "../ingest/identity.js";
import { WINDOW_RULE } from "../jobs/embed-lines.js";
import { HttpError } from "../lib/http.js";
import { UNATTRIBUTED, displayTitle, formatTimestamp, type FileSegment } from "../lib/transcript-file.js";
import { embed } from "../lib/voyage.js";
import { pushDateRangeConditions } from "./search-moments.js";
import { transcriptLines } from "./transcript-page.js";

export const searchTranscriptsQuerySchema = z.object({
  query: z.string().max(512).optional(),
  semanticQuery: z.string().min(1).max(2048).optional(),
  recordingId: z.string().uuid().optional(),
  scope: z.enum(["work", "personal", "all"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type SearchTranscriptsQuery = z.infer<typeof searchTranscriptsQuerySchema>;

export const SEMANTIC_DEFAULT_LIMIT = 10;
export const SEMANTIC_MAX_LIMIT = 50;

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

export type MeaningHit = {
  recordingId: string;
  recordingTitle: string;
  startedAt: string | null;
  segment: number;
  lastSegment: number;
  time: string;
  startSec: number;
  similarity: number;
  embeddingModel: string;
  lines: string[];
};

const r = schema.recordings;
const w = schema.transcriptWindows;

// The calls a search reads, for both paths: visible, not trashed, the scope and
// the dates; a recordingId the caller can't see is the same 404 as one that
// doesn't exist.
async function callsInScope(ctx: AccessContext, query: SearchTranscriptsQuery) {
  const resolvedScope = query.scope ?? "work";
  const scopeDefaulted = query.scope === undefined;
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
  const recordings = await db
    .select({ id: r.id, title: r.title, startedAt: r.startedAt, metadata: r.metadata })
    .from(r)
    .where(and(...conditions));
  return { recordings, resolvedScope, scopeDefaulted };
}

// Each call's lines as get_transcript renders them, keyed by recording.
async function linesOf(recordings: Array<{ id: string; metadata: unknown }>) {
  const ids = recordings.map((x) => x.id);
  const out = new Map<string, { segs: FileSegment[]; names: Map<string | null, string>; texts: string[]; lines: (string | null)[] }>();
  if (ids.length === 0) return out;

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
  if (firstTranscript.size === 0) return out;

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

  for (const rec of recordings) {
    const segs = byTranscript.get(firstTranscript.get(rec.id) ?? "") ?? [];
    if (segs.length === 0) continue;
    out.set(rec.id, { segs, ...transcriptLines(segs, hosts.get(rec.id) ?? null, micSharedIn(rec.metadata)) });
  }
  return out;
}

export async function searchTranscripts(ctx: AccessContext, query: SearchTranscriptsQuery) {
  if ((query.query === undefined) === (query.semanticQuery === undefined)) {
    throw new HttpError(400, "pass_exactly_one_of_query_or_semanticQuery");
  }
  if (query.semanticQuery !== undefined) return searchTranscriptsByMeaning(ctx, query, query.semanticQuery);
  const words = query.query!.split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
  if (words.length === 0) throw new HttpError(400, "query_has_no_words");
  const limit = query.limit ?? 50;
  const { recordings, resolvedScope, scopeDefaulted } = await callsInScope(ctx, query);
  const empty = { hits: [] as TranscriptHit[], totalMatches: 0, truncated: false, scope: resolvedScope, scopeDefaulted };
  if (recordings.length === 0) return empty;
  const rendered = await linesOf(recordings);

  const matches: Array<TranscriptHit & { rank: number; startedMs: number }> = [];
  for (const rec of recordings) {
    const got = rendered.get(rec.id);
    if (!got) continue;
    const { segs, names, texts, lines } = got;
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

async function searchTranscriptsByMeaning(ctx: AccessContext, query: SearchTranscriptsQuery, semanticQuery: string) {
  const limit = query.limit ?? SEMANTIC_DEFAULT_LIMIT;
  if (limit > SEMANTIC_MAX_LIMIT) throw new HttpError(400, `limit_above_${SEMANTIC_MAX_LIMIT}_for_semanticQuery`);
  const { recordings, resolvedScope, scopeDefaulted } = await callsInScope(ctx, query);
  const ids = recordings.map((x) => x.id);
  const withWindows =
    ids.length === 0
      ? new Set<string>()
      : new Set(
          (await db.selectDistinct({ id: w.recordingId }).from(w).where(and(inArray(w.recordingId, ids), eq(w.windowRule, WINDOW_RULE)))).map((x) => x.id),
        );
  const base = { scope: resolvedScope, scopeDefaulted, callsSearched: withWindows.size, callsNotYetSearchable: recordings.length - withWindows.size };
  if (withWindows.size === 0) return { hits: [] as MeaningHit[], ...base };

  // input_type=query is load-bearing (Decision 13): the windows were embedded as
  // "document".
  const [qvec] = await embed([semanticQuery], "query");
  const distance = cosineDistance(w.embedding, qvec);
  // Enough candidates that dropping overlaps still fills a page: a window
  // overlaps at most its two neighbours.
  const candidates = await db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
    await tx.execute(sql`set local hnsw.ef_search = 200`);
    return tx
      .select({
        recordingId: w.recordingId,
        first: w.firstSegment,
        last: w.lastSegment,
        model: w.embeddingModel,
        similarity: sql<number>`1 - (${distance})`,
      })
      .from(w)
      .where(and(inArray(w.recordingId, [...withWindows]), eq(w.windowRule, WINDOW_RULE)))
      .orderBy(asc(distance))
      .limit(limit * 4);
  });

  const kept: typeof candidates = [];
  for (const c of candidates) {
    if (kept.length === limit) break;
    if (kept.some((k) => k.recordingId === c.recordingId && k.first <= c.last && c.first <= k.last)) continue;
    kept.push(c);
  }
  const byId = new Map(recordings.map((x) => [x.id, x]));
  const rendered = await linesOf(recordings.filter((x) => kept.some((k) => k.recordingId === x.id)));
  const hits: MeaningHit[] = kept.flatMap((k) => {
    const rec = byId.get(k.recordingId);
    const got = rendered.get(k.recordingId);
    if (!rec || !got || !got.segs[k.first]) return [];
    return [{
      recordingId: k.recordingId,
      recordingTitle: displayTitle(rec.title),
      startedAt: rec.startedAt ? rec.startedAt.toISOString() : null,
      segment: k.first,
      lastSegment: k.last,
      time: formatTimestamp(got.segs[k.first].startSec),
      startSec: got.segs[k.first].startSec,
      similarity: Number(k.similarity),
      embeddingModel: k.model,
      lines: got.lines.slice(k.first, k.last + 1).filter((l): l is string => l !== null),
    }];
  });
  return { hits, ...base };
}
