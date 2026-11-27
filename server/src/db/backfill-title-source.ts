// The backfill for recordings.title_source (SAA-135): gives every recorder
// capture written before the column its source, and an answered call that still
// shows the placeholder its fallback title ("Call with …").
//
//   npx tsx src/db/backfill-title-source.ts                      dry run: counts only, writes nothing
//   npx tsx src/db/backfill-title-source.ts --apply --expect=<n> writes, in one transaction
//   built: node dist/db/backfill-title-source.js [--apply --expect=<n>]   (on the host, where the key is)
//
// The rows are the recorder captures (source clipwise-recorder) with no
// title_source. Each title is decrypted here, so it runs where CALL_TEXT_KEY is,
// and is sorted by what it holds:
//   the placeholder ("Clipwise capture — …"), with an answer stored
//                        -> its fallback from the attendee rows, source fallback
//                           (ingest/title.ts refreshFallbackTitle, the code path
//                           POST /captures uses)
//   the placeholder, no answer   -> unchanged, source placeholder
//   anything else                -> unchanged, source calendar: before this column
//                                   no route but the calendar match ever wrote a
//                                   recorder capture's title
//
// --apply needs --expect=<n>, the dry run's total. Every write is guarded on the
// row still having no source, so a rename landing meanwhile is never overwritten;
// it is then not counted, the count no longer equals n, and the whole transaction
// rolls back (exit 2): run the dry run again. A second run finds nothing to do.
// It prints counts only: never a title, a name or an id.

import { and, eq, isNull, sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { db, pool, schema } from "./index.js";
import { CLIPWISE_SOURCE, titlePlaceholderFor } from "../ingest/clipwise.js";
import { refreshFallbackTitle } from "../ingest/title.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TitleSourcePlan = { total: number; toFallback: number; toPlaceholder: number; toCalendar: number };
export type TitleSourceResult = { plan: TitleSourcePlan; applied: boolean; changed: number; refused?: string };

type Kind = "fallback" | "placeholder" | "calendar";

class ExpectMismatch extends Error {}

async function rowsToFill(executor: typeof db | Tx): Promise<Array<{ id: string; kind: Kind }>> {
  const rows = await executor
    .select({
      id: schema.recordings.id,
      title: schema.recordings.title,
      answered: sql<boolean>`jsonb_typeof(${schema.recordings.metadata}->'identity') = 'object'`,
    })
    .from(schema.recordings)
    .where(and(eq(schema.recordings.source, CLIPWISE_SOURCE), isNull(schema.recordings.titleSource)))
    .orderBy(schema.recordings.id);
  const prefix = titlePlaceholderFor("");
  return rows.map((r) => {
    const placeholder = r.title === null || r.title.startsWith(prefix);
    return { id: r.id, kind: placeholder ? (r.answered ? "fallback" : "placeholder") : "calendar" };
  });
}

function planOf(rows: Array<{ kind: Kind }>): TitleSourcePlan {
  return {
    total: rows.length,
    toFallback: rows.filter((r) => r.kind === "fallback").length,
    toPlaceholder: rows.filter((r) => r.kind === "placeholder").length,
    toCalendar: rows.filter((r) => r.kind === "calendar").length,
  };
}

// Sets the source on a row that still has none. Whether it was written.
async function setSource(tx: Tx, id: string, source: "placeholder" | "calendar"): Promise<boolean> {
  const written = await tx
    .update(schema.recordings)
    .set({ titleSource: source })
    .where(and(eq(schema.recordings.id, id), isNull(schema.recordings.titleSource)))
    .returning({ id: schema.recordings.id });
  return written.length > 0;
}

export async function runTitleSourceBackfill(opts: { apply: boolean; expect?: number }): Promise<TitleSourceResult> {
  if (!opts.apply) {
    const plan = planOf(await rowsToFill(db));
    return { plan, applied: false, changed: 0 };
  }
  if (opts.expect === undefined || !Number.isInteger(opts.expect) || opts.expect < 0) {
    return { plan: planOf(await rowsToFill(db)), applied: false, changed: 0, refused: "--apply needs --expect=<n>, the dry run's total" };
  }
  const expected = opts.expect;
  let plan: TitleSourcePlan = { total: 0, toFallback: 0, toPlaceholder: 0, toCalendar: 0 };
  try {
    const changed = await db.transaction(async (tx) => {
      const rows = await rowsToFill(tx);
      plan = planOf(rows);
      let n = 0;
      for (const r of rows) {
        if (r.kind === "calendar") {
          if (await setSource(tx, r.id, "calendar")) n++;
        } else if (await setSource(tx, r.id, "placeholder")) {
          n++;
          // The fallback over the placeholder just marked, as POST /captures writes it.
          if (r.kind === "fallback") await refreshFallbackTitle(tx, r.id);
        }
      }
      if (n !== expected) throw new ExpectMismatch(`expected ${expected}, would change ${n}`);
      return n;
    });
    return { plan, applied: true, changed };
  } catch (err) {
    if (err instanceof ExpectMismatch) return { plan, applied: false, changed: 0, refused: err.message };
    throw err;
  }
}

async function cli(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const expectArg = args.find((a) => a.startsWith("--expect="));
  const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--expect="));
  if (unknown.length > 0) {
    console.error(`backfill-title-source: refused: unknown argument(s) ${unknown.length}; usage: [--apply --expect=<n>]`);
    return 2;
  }
  const expect = expectArg === undefined ? undefined : Number(expectArg.slice("--expect=".length));
  const result = await runTitleSourceBackfill({ apply, expect });
  const p = result.plan;
  console.log(`backfill-title-source: ${apply ? "apply" : "dry run"}: rows with no source=${p.total} fallback=${p.toFallback} placeholder=${p.toPlaceholder} calendar=${p.toCalendar}`);
  if (result.refused) {
    console.error(`backfill-title-source: refused, nothing written: ${result.refused}`);
    return 2;
  }
  if (apply) console.log(`backfill-title-source: changed=${result.changed}; run again to confirm 0`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli()
    .then(async (code) => {
      await pool.end();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(`backfill-title-source: failed: ${err instanceof Error ? err.name : "error"}`);
      await pool.end();
      process.exit(1);
    });
}
