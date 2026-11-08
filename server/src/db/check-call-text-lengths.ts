// Totals of call text read back through the ORM (SAA-277 step 6b): per target,
// how many values there are and their total length in code points, after the
// columns decrypt them. For the rehearsal of the backfill on a copy of main's
// data: run before the backfill as SQL on the plain values, and after it as this,
// the two must agree per target. Read-only: it only selects.
//
//   scripts/scratch-db.sh run check-call-text-lengths
//
// Prints labels and numbers only, as label|count|chars, the shape of the SQL it is
// compared with. Code points, as Postgres's char_length counts, not UTF-16 units
// (String.length). speakers is the sum of its elements' lengths, as
// jsonb_array_elements_text gives them. A value that does not decrypt stops the
// run, and only its error class is printed (a CallTextKeyError's message, which
// names key ids only).

import { asc, gt } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { CallTextKeyError } from "../lib/call-text.js";
import { refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { db, pool, schema } from "./index.js";

await refuseUnlessScratch("check-call-text-lengths");

const cp = (s: string): number => [...s].length;
type Acc = { n: number; chars: number };
const acc = (): Acc => ({ n: 0, chars: 0 });
const totals = {
  "recordings.title": acc(),
  "transcripts.text": acc(),
  "segments.text": acc(),
  "moments.title": acc(),
  "moments.summary": acc(),
  "clips.title": acc(),
  "clips.description": acc(),
  "moments.metadata.span_label": acc(),
  "moments.metadata.speakers": acc(),
  "moments.metadata.speakers (not an array, not null)": acc(),
  "recordings.metadata.dropped_text": acc(),
};
const addText = (a: Acc, v: string | null) => {
  if (v === null) return;
  a.n++;
  a.chars += cp(v);
};

// Every row of a table, 5000 at a time, in id order.
async function eachRow<T extends { id: string }>(table: PgTable, id: PgColumn, fields: Record<string, PgColumn>, fn: (row: T) => void): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const rows = (await db
      .select({ id, ...fields })
      .from(table)
      .where(after ? gt(id, after) : undefined)
      .orderBy(asc(id))
      .limit(5000)) as unknown as T[];
    if (rows.length === 0) return;
    for (const r of rows) fn(r);
    after = rows[rows.length - 1].id;
  }
}

try {
  const r = schema.recordings;
  await eachRow<{ id: string; title: string | null; metadata: unknown }>(r, r.id, { title: r.title, metadata: r.metadata }, (row) => {
    addText(totals["recordings.title"], row.title);
    const dropped = (row.metadata as { capture_quality?: { dropped_segments?: unknown } } | null)?.capture_quality?.dropped_segments;
    if (Array.isArray(dropped)) {
      for (const s of dropped) {
        if (s && typeof s === "object" && !Array.isArray(s) && typeof (s as { text?: unknown }).text === "string") addText(totals["recordings.metadata.dropped_text"], (s as { text: string }).text);
      }
    }
  });
  const t = schema.transcripts;
  await eachRow<{ id: string; text: string | null }>(t, t.id, { text: t.text }, (row) => addText(totals["transcripts.text"], row.text));
  const s = schema.segments;
  await eachRow<{ id: string; text: string }>(s, s.id, { text: s.text }, (row) => addText(totals["segments.text"], row.text));
  const m = schema.moments;
  await eachRow<{ id: string; title: string | null; summary: string | null; metadata: unknown }>(m, m.id, { title: m.title, summary: m.summary, metadata: m.metadata }, (row) => {
    addText(totals["moments.title"], row.title);
    addText(totals["moments.summary"], row.summary);
    const meta = row.metadata as Record<string, unknown> | null;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      if (typeof meta.span_label === "string") addText(totals["moments.metadata.span_label"], meta.span_label);
      if (Array.isArray(meta.speakers)) {
        const a = totals["moments.metadata.speakers"];
        a.n++;
        for (const e of meta.speakers) if (e !== null) a.chars += cp(typeof e === "string" ? e : JSON.stringify(e));
      } else if ("speakers" in meta && meta.speakers !== null) {
        totals["moments.metadata.speakers (not an array, not null)"].n++;
      }
    }
  });
  const c = schema.clips;
  await eachRow<{ id: string; title: string | null; description: string | null }>(c, c.id, { title: c.title, description: c.description }, (row) => {
    addText(totals["clips.title"], row.title);
    addText(totals["clips.description"], row.description);
  });
  for (const [label, a] of Object.entries(totals)) console.log(`${label}|${a.n}|${a.chars}`);
} catch (err) {
  console.error(`check-call-text-lengths: failed: ${err instanceof CallTextKeyError ? err.message : err instanceof Error ? err.constructor.name : typeof err}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
