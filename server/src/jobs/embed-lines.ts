// A call's transcript windows, for search by meaning (SAA-370 step 2): the
// embed_lines job's work (jobs/worker.ts executeEmbedLines).
//
// The window rule (window_rule "lines8-step4"): the call's first transcript, its
// segments in order, numbered by position as get_transcript numbers them. A
// segment whose text is empty once whitespace is collapsed keeps its number but
// is not shown, and is in no window. The shown lines are cut into windows of
// WINDOW_LINES, each starting WINDOW_STEP shown lines after the last, the last
// window ending at the last shown line; fewer than WINDOW_LINES shown lines make
// one window. A window's text is its lines' words, whitespace collapsed, joined
// by "\n": no speaker names, no times. Changing any of this is a new
// WINDOW_RULE and a re-embed (Decision 13).
//
// Embedded with input_type "document" (search embeds with "query"; Decision 13).
// All of a call's windows are written in one transaction, fenced on the job's
// lease, after a FOR SHARE read of the recording: a recording deleted while its
// embedding was in flight gets no rows (none are written), and one deleted after
// takes its rows with it (the cascade).
//
// Nothing of the call is logged: the caller logs the count.

import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Embedder } from "../extract/embeddings.js";
import { LeaseLostError } from "../extract/extract.js";
import { collapse } from "../services/transcript-page.js";
import { currentEmbeddingModel, embed } from "../lib/voyage.js";

export const WINDOW_RULE = "lines8-step4";
const WINDOW_LINES = 8;
const WINDOW_STEP = 4;

export type Window = { first: number; last: number; text: string };

// texts[i] is segment #i's text as stored (decrypted).
export function windowsOf(texts: string[]): Window[] {
  const collapsed = texts.map(collapse);
  const shown = collapsed.flatMap((t, i) => (t === "" ? [] : [i]));
  const out: Window[] = [];
  if (shown.length === 0) return out;
  for (let s = 0; ; s += WINDOW_STEP) {
    const e = Math.min(s + WINDOW_LINES - 1, shown.length - 1);
    out.push({ first: shown[s], last: shown[e], text: shown.slice(s, e + 1).map((i) => collapsed[i]).join("\n") });
    if (e === shown.length - 1) return out;
  }
}

const voyageEmbedder: Embedder = (texts, inputType, signal) => embed(texts, inputType, undefined, signal);

export async function embedLines(
  job: { jobId: string; leaseToken: string; accountId: string; recordingId: string },
  opts: { embedder?: Embedder; signal?: AbortSignal } = {},
): Promise<{ windows: number }> {
  const [transcript] = await db
    .select({ id: schema.transcripts.id })
    .from(schema.transcripts)
    .where(eq(schema.transcripts.recordingId, job.recordingId))
    .orderBy(asc(schema.transcripts.createdAt))
    .limit(1);
  if (!transcript) return { windows: 0 };
  // Through the column, which decrypts (call-text-columns.ts).
  const segs = await db
    .select({ text: schema.segments.text })
    .from(schema.segments)
    .where(eq(schema.segments.transcriptId, transcript.id))
    .orderBy(asc(schema.segments.orderIndex));
  const windows = windowsOf(segs.map((s) => s.text));
  const vectors = windows.length > 0 ? await (opts.embedder ?? voyageEmbedder)(windows.map((w) => w.text), "document", opts.signal) : [];
  if (vectors.length !== windows.length) throw new Error(`embed_lines: ${vectors.length} vector(s) for ${windows.length} window(s)`);
  opts.signal?.throwIfAborted();
  const model = currentEmbeddingModel();
  let written = 0;
  await db.transaction(async (tx) => {
    const fence = await tx.execute(
      sql`update jobs set updated_at = now() where id = ${job.jobId} and lease_token = ${job.leaseToken} and state = 'running'`,
    );
    if (fence.rowCount === 0) throw new LeaseLostError();
    const [rec] = await tx
      .select({ id: schema.recordings.id })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, job.recordingId))
      .for("share");
    if (!rec) return;
    await tx
      .delete(schema.transcriptWindows)
      .where(and(eq(schema.transcriptWindows.transcriptId, transcript.id), eq(schema.transcriptWindows.windowRule, WINDOW_RULE)));
    if (windows.length === 0) return;
    await tx.insert(schema.transcriptWindows).values(
      windows.map((w, i) => ({
        accountId: job.accountId,
        recordingId: job.recordingId,
        transcriptId: transcript.id,
        firstSegment: w.first,
        lastSegment: w.last,
        embedding: vectors[i],
        embeddingModel: model,
        windowRule: WINDOW_RULE,
      })),
    );
    written = windows.length;
  });
  return { windows: written };
}
