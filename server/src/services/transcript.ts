// A recording's transcript, for a caller who is allowed to see the recording.
// The same 404 for "does not exist", "trashed" (SAA-154) and "not yours to
// see", so the answer does not reveal which.

import { and, eq, isNull } from "drizzle-orm";
import type { AccessContext } from "../access/context.js";
import { recordingVisibleTo } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { HttpError } from "../lib/http.js";
import { readTranscript } from "../lib/transcript-read.js";

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
