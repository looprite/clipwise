// The one place a recording's transcript is read from the database. Both the
// GET /recordings/:id/transcript route (what the MCP tool get_transcript
// calls) and the saved transcript file (SAA-199) read through this, so the
// file and what Claude sees can't disagree about who said what.

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { buildTurns, formatTranscriptFile, suggestedFileName, UNATTRIBUTED } from "./transcript-file.js";

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

// The saved transcript file (SAA-199), as text, with what the Save dialog and
// the recorder's log need. One builder for the Mac's save-transcript.ts and the
// recorder's GET /captures/:captureId/transcript, so the two give the same bytes.
// Null when the recording is not there or is in the trash (SAA-154: a trashed
// recording is not saved, as it is not found by Claude). The date and the file
// name are in timeZone (an IANA name) when one is given, else this process's own.
export type TranscriptFile = { text: string; suggestedFileName: string; lines: number; turns: number; unattributedTurns: number };

export async function buildTranscriptFile(recordingId: string, timeZone?: string): Promise<TranscriptFile | null> {
  const [recording] = await db
    .select({
      title: schema.recordings.title,
      startedAt: schema.recordings.startedAt,
      durationSec: schema.recordings.durationSec,
    })
    .from(schema.recordings)
    .where(and(eq(schema.recordings.id, recordingId), isNull(schema.recordings.trashedAt)));
  if (!recording) return null;

  const [host] = await db
    .select({ name: schema.attendees.name })
    .from(schema.attendees)
    .where(
      and(
        eq(schema.attendees.recordingId, recordingId),
        eq(schema.attendees.isHost, true),
        isNotNull(schema.attendees.name),
      ),
    )
    .limit(1);

  const { segments } = await readTranscript(recordingId);
  const input = {
    title: recording.title,
    hostName: host?.name ?? null,
    startedAt: recording.startedAt,
    durationSec: recording.durationSec,
    segments,
  };
  const turns = buildTurns(segments, host?.name ?? null);
  return {
    text: segments.length > 0 ? formatTranscriptFile(input, timeZone) : "",
    suggestedFileName: suggestedFileName(input, timeZone),
    lines: segments.length,
    turns: turns.length,
    unattributedTurns: turns.filter((t) => t.name === UNATTRIBUTED).length,
  };
}
