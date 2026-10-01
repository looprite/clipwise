// The one place a recording's transcript is read from the database. Both the
// GET /recordings/:id/transcript route (what the MCP tool get_transcript
// calls) and the saved transcript file (SAA-199) read through this, so the
// file and what Claude sees can't disagree about who said what.

import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export type TranscriptSegmentRow = {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  speakerLabel: string | null;
  speakerDisplayName: string | null;
};

export type TranscriptRead = {
  transcript: { id: string; provider: string | null; language: string | null; status: string } | null;
  segments: TranscriptSegmentRow[];
};

export async function readTranscript(recordingId: string): Promise<TranscriptRead> {
  const [transcript] = await db
    .select()
    .from(schema.transcripts)
    .where(eq(schema.transcripts.recordingId, recordingId))
    .orderBy(asc(schema.transcripts.createdAt))
    .limit(1);

  if (!transcript) return { transcript: null, segments: [] };

  const segments = await db
    .select({
      id: schema.segments.id,
      startSec: schema.segments.startSec,
      endSec: schema.segments.endSec,
      text: schema.segments.text,
      speakerLabel: schema.speakers.label,
      speakerDisplayName: schema.speakers.displayName,
    })
    .from(schema.segments)
    .leftJoin(schema.speakers, eq(schema.segments.speakerId, schema.speakers.id))
    .where(eq(schema.segments.transcriptId, transcript.id))
    .orderBy(asc(schema.segments.orderIndex));

  return {
    transcript: {
      id: transcript.id,
      provider: transcript.provider,
      language: transcript.language,
      status: transcript.status,
    },
    segments,
  };
}
