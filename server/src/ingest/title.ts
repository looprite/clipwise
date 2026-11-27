// Writing a recording's title (SAA-135). Three writers share the column, each
// in its own transaction: the fallback here, the calendar match
// (ingest/calendar-match.ts) and a rename (routes/capture-scope.ts). Each is one
// UPDATE whose WHERE names the title_source values it may replace, so whichever
// lands second sees what the first wrote, and a rename is never overwritten by a
// match or a fallback that started before it. See schema.ts title_source.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { titlePlaceholderFor } from "./clipwise.js";
import { fallbackTitleFor } from "./fallback-title.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// What a fallback and a calendar match may replace.
export const REPLACEABLE_TITLE_SOURCES = ["placeholder", "fallback"] as const;

// The title to show a person: null while it is still the placeholder (the Mac
// then shows "Untitled"), whatever the source says, so a placeholder for
// another stem (ingest/clipwise.ts's basename fallback) is not shown either.
export function shownTitle(title: string | null, titleSource: string | null): string | null {
  if (!title || titleSource === "placeholder") return null;
  return title.startsWith(titlePlaceholderFor("")) ? null : title;
}

// The fallback from the recording's attendee rows as they stand, written only
// over a placeholder or an earlier fallback. Called after the member's answer
// (or a correction) is applied, in the same transaction. A row with no
// title_source (before the backfill) is left alone. Returns whether it wrote.
export async function refreshFallbackTitle(executor: typeof db | Tx, recordingId: string): Promise<boolean> {
  // By name: an answer's rows are inserted in one transaction, so created_at
  // ties and the id tiebreak is random. Alphabetical is the one order that is
  // the same every time; the typed order is not stored.
  const rows = await executor
    .select({ name: schema.attendees.name, isHost: schema.attendees.isHost })
    .from(schema.attendees)
    .where(eq(schema.attendees.recordingId, recordingId))
    .orderBy(asc(sql`lower(${schema.attendees.name})`), asc(schema.attendees.id));
  const written = await executor
    .update(schema.recordings)
    .set({ title: fallbackTitleFor(rows), titleSource: "fallback", updatedAt: new Date() })
    .where(and(eq(schema.recordings.id, recordingId), inArray(schema.recordings.titleSource, [...REPLACEABLE_TITLE_SOURCES])))
    .returning({ id: schema.recordings.id });
  return written.length > 0;
}
