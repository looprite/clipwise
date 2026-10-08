// A recording's transcript, for a caller who is allowed to see the recording.
// The same 404 for "does not exist", "trashed" (SAA-154) and "not yours to
// see", so the answer does not reveal which.

import { and, eq, isNull } from "drizzle-orm";
import type { AccessContext } from "../access/context.js";
import { recordingVisibleTo } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { HttpError } from "../lib/http.js";
import { readTranscript } from "../lib/transcript-read.js";
import { pageTranscript, type Page, type PageRequest } from "./transcript-page.js";

export async function getTranscriptFor(ctx: AccessContext, recordingId: string) {
  const [recording] = await db
    .select({ id: schema.recordings.id })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.id, recordingId),
        isNull(schema.recordings.trashedAt),
        recordingVisibleTo(ctx),
      ),
    );
  if (!recording) throw new HttpError(404, "recording_not_found");
  return readTranscript(recordingId);
}

// One page of a recording's transcript as text (SAA-226), with what a reader
// needs to cite it: title, date, length. Same visibility and the same 404 as
// getTranscriptFor. The host's name is worked out the way the saved transcript
// file does it (the recording's host attendee), for the `me` speaker.
export async function getTranscriptPage(
  ctx: AccessContext,
  recordingId: string,
  req: PageRequest,
): Promise<{ title: string | null; startedAt: Date | null; durationSec: number | null; page: Page }> {
  const [recording] = await db
    .select({
      id: schema.recordings.id,
      title: schema.recordings.title,
      startedAt: schema.recordings.startedAt,
      durationSec: schema.recordings.durationSec,
    })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.id, recordingId),
        isNull(schema.recordings.trashedAt),
        recordingVisibleTo(ctx),
      ),
    );
  if (!recording) throw new HttpError(404, "recording_not_found");

  const [host] = await db
    .select({ name: schema.attendees.name })
    .from(schema.attendees)
    .where(and(eq(schema.attendees.recordingId, recordingId), eq(schema.attendees.isHost, true)))
    .limit(1);
  const { segments } = await readTranscript(recordingId);
  return {
    title: recording.title,
    startedAt: recording.startedAt,
    durationSec: recording.durationSec,
    page: pageTranscript(segments, host?.name ?? null, req),
  };
}
