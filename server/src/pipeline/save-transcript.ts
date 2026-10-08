// Writes one recording's named transcript to a text file (SAA-199). The
// recorder spawns this when "Save transcript" is chosen in the tray: main.js
// has no database access, so it asks this for the file (to a temporary path),
// shows the Save dialog with the suggested name, and copies it where the
// person chose.
//
// Usage:
//   tsx src/pipeline/save-transcript.ts <capture_dir> --stem <stem> --out <path>
//   tsx src/pipeline/save-transcript.ts --recording <uuid> --out <path>
//
// Prints one line, "SAVE_TRANSCRIPT_META {json}", on success — a marker so
// the caller can find it among whatever else the process writes to stdout.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db, pool, schema } from "../db/index.js";
import { describeErrorLine } from "../lib/safe-error.js";
import { readTranscript } from "../lib/transcript-read.js";
import {
  buildTurns,
  formatTranscriptFile,
  suggestedFileName,
  UNATTRIBUTED,
} from "../lib/transcript-file.js";

function usage(): never {
  process.stderr.write(
    "usage: tsx src/pipeline/save-transcript.ts <capture_dir> --stem <stem> --out <path>\n" +
      "       tsx src/pipeline/save-transcript.ts --recording <uuid> --out <path>\n",
  );
  process.exit(2);
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function recordingIdFromCapture(dir: string, stem: string): string {
  const path = join(dir, `pipeline-${stem}.json`);
  if (!existsSync(path)) throw new Error(`no pipeline record at ${path}`);
  const doc = JSON.parse(readFileSync(path, "utf8")) as { db_recording_id?: string };
  if (!doc.db_recording_id) throw new Error(`pipeline record ${path} has no db_recording_id (not ingested)`);
  return doc.db_recording_id;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = flag(args, "--out");
  const stem = flag(args, "--stem");
  const recordingFlag = flag(args, "--recording");
  const dir = args[0] && !args[0].startsWith("--") ? args[0] : null;
  if (!out || (!recordingFlag && !(dir && stem))) usage();

  const recordingId = recordingFlag ?? recordingIdFromCapture(dir!, stem!);

  const [recording] = await db
    .select({
      title: schema.recordings.title,
      startedAt: schema.recordings.startedAt,
      durationSec: schema.recordings.durationSec,
    })
    .from(schema.recordings)
    // A trashed recording is not saved (SAA-154): not found, like to Claude.
    .where(and(eq(schema.recordings.id, recordingId), isNull(schema.recordings.trashedAt)));
  if (!recording) throw new Error(`recording ${recordingId} not found`);

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
  if (segments.length === 0) throw new Error(`recording ${recordingId} has no transcript lines`);

  const input = {
    title: recording.title,
    hostName: host?.name ?? null,
    startedAt: recording.startedAt,
    durationSec: recording.durationSec,
    segments,
  };
  writeFileSync(out!, formatTranscriptFile(input), "utf8");

  const turns = buildTurns(segments, host?.name ?? null);
  process.stdout.write(
    "SAVE_TRANSCRIPT_META " +
      JSON.stringify({
        ok: true,
        recordingId,
        suggestedFileName: suggestedFileName(input),
        lines: segments.length,
        turns: turns.length,
        unattributedTurns: turns.filter((t) => t.name === UNATTRIBUTED).length,
      }) +
      "\n",
  );
}

main()
  .catch((err) => {
    process.stderr.write(`save-transcript: ${describeErrorLine(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
