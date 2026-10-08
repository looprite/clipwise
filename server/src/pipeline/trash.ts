// Trash, restore and permanent delete for a capture (SAA-154, decided
// 2026-10-02). The recorder spawns this: main.js has no database access.
//
// Trashed state is one fact kept in two places. The marker file
// trashed-<stem>.json (lib/trash-marker.ts) is what the Mac side reads — the
// windows, the "Save transcript" item and recovery. recordings.trashed_at is
// what Claude's tools read. This script is the only writer of both.
//
// Trash:    marker first, then the column. If the column write fails the
//           marker is removed again and nothing has been moved: a trash that
//           Claude's tools would not honour is refused rather than half done.
// Restore:  column first, then the marker. If the column write fails the
//           marker stays and the capture stays in the trash.
// Delete:   only from the trash. Files first, row second, marker last (the
//           09-20 finding on SAA-154: a row deleted while its files remain is
//           re-ingested by recovery under a new id). The manifest is the
//           last file to go because recovery enumerates manifests, and the
//           marker outlives the row so that a crash anywhere in the sequence
//           leaves a capture that is still in the trash, still hidden from
//           Claude, and can be deleted again.
// Reconcile: a crash between the marker and the column write leaves them
//           disagreeing. The marker is the intent; reconcileTrash makes the
//           column match it. The recovery pass calls it on every run.
//
// Usage:
//   tsx src/pipeline/trash.ts <capture_dir> trash|restore|delete --stem <stem> [--stem <stem> ...]
//
// Prints one line per stem, "TRASH_RESULT {json}", for the caller to find.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db, pool, schema } from "../db/index.js";
import { CLIPWISE_SOURCE } from "../ingest/clipwise.js";
import { describeErrorLine } from "../lib/safe-error.js";
import {
  STEM_RE,
  captureFiles,
  isTrashed,
  readMarker,
  removeMarker,
  trashedStems,
  writeMarker,
} from "../lib/trash-marker.js";

export type TrashErrorCode = "bad_stem" | "no_manifest" | "not_trashed" | "db_unreachable";

export class TrashError extends Error {
  constructor(
    readonly code: TrashErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function checkStem(stem: string): void {
  if (!STEM_RE.test(stem)) throw new TrashError("bad_stem", `not a capture stem: ${stem}`);
}

// The key ingest files the row under: the manifest's recording_id, else the
// stem (ingest/clipwise.ts, `capture?.recordingId ?? stamp`).
function sourceIdFromManifest(dir: string, stem: string): string | null {
  const path = join(dir, `manifest-${stem}.json`);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { recording_id?: string };
    return doc.recording_id || stem;
  } catch {
    return null;
  }
}

// Sets or clears the column on the row filed under this source id. Zero rows
// is not an error: a capture that never reached ingest has no row, and its
// marker alone keeps recovery away from it.
async function setTrashed(sourceId: string, at: Date | null): Promise<number> {
  try {
    const rows = await db
      .update(schema.recordings)
      .set({ trashedAt: at })
      .where(
        and(eq(schema.recordings.source, CLIPWISE_SOURCE), eq(schema.recordings.sourceId, sourceId)),
      )
      .returning({ id: schema.recordings.id });
    return rows.length;
  } catch (err) {
    throw new TrashError(
      "db_unreachable",
      `could not write trashed_at: ${describeErrorLine(err)}`,
    );
  }
}

export async function trashCapture(dir: string, stem: string): Promise<{ rows: number }> {
  checkStem(stem);
  const existing = readMarker(dir, stem);
  const sourceId = existing?.source_id ?? sourceIdFromManifest(dir, stem);
  if (!sourceId) throw new TrashError("no_manifest", `no readable manifest for ${stem}`);
  const marker = existing ?? { stem, source_id: sourceId, trashed_at: new Date().toISOString() };
  const created = !isTrashed(dir, stem);
  if (created) writeMarker(dir, marker);
  try {
    return { rows: await setTrashed(sourceId, new Date(marker.trashed_at)) };
  } catch (err) {
    if (created) removeMarker(dir, stem);
    throw err;
  }
}

export async function restoreCapture(dir: string, stem: string): Promise<{ rows: number }> {
  checkStem(stem);
  const marker = readMarker(dir, stem);
  if (!marker) throw new TrashError("not_trashed", `${stem} is not in the trash`);
  const rows = await setTrashed(marker.source_id, null);
  removeMarker(dir, stem);
  return { rows };
}

export async function deleteCapture(
  dir: string,
  stem: string,
): Promise<{ files: number; rowsDeleted: number }> {
  checkStem(stem);
  const marker = readMarker(dir, stem);
  if (!marker) throw new TrashError("not_trashed", `${stem} is not in the trash; permanent delete only acts on trashed captures`);

  // The database must be reachable before anything is removed, and the row
  // must be hidden from Claude for the whole of the delete.
  await setTrashed(marker.source_id, new Date(marker.trashed_at));

  const manifest = `manifest-${stem}.json`;
  const marked = `trashed-${stem}.json`;
  const files = captureFiles(dir, stem);
  let removed = 0;
  for (const name of files) {
    if (name === manifest || name === marked) continue;
    rmSync(join(dir, name), { force: true });
    removed++;
  }
  if (files.includes(manifest)) {
    rmSync(join(dir, manifest), { force: true });
    removed++;
  }

  let rowsDeleted = 0;
  try {
    // Only a row that is still trashed: never one restored mid-delete.
    const gone = await db
      .delete(schema.recordings)
      .where(
        and(
          eq(schema.recordings.source, CLIPWISE_SOURCE),
          eq(schema.recordings.sourceId, marker.source_id),
          isNotNull(schema.recordings.trashedAt),
        ),
      )
      .returning({ id: schema.recordings.id });
    rowsDeleted = gone.length;
  } catch (err) {
    throw new TrashError(
      "db_unreachable",
      `files removed, row not deleted (delete again to finish): ${describeErrorLine(err)}`,
    );
  }
  removeMarker(dir, stem);
  return { files: removed, rowsDeleted };
}

// Makes recordings.trashed_at match the markers in this directory, both ways,
// for the captures this directory holds (its markers and its manifests) and
// no others. Called by the recovery pass.
export async function reconcileTrash(dir: string): Promise<{ marked: number; cleared: number }> {
  let marked = 0;
  for (const stem of trashedStems(dir)) {
    const marker = readMarker(dir, stem);
    const sourceId = marker?.source_id ?? sourceIdFromManifest(dir, stem);
    if (!sourceId) continue;
    const at = marker ? new Date(marker.trashed_at) : new Date();
    marked += await setTrashed(sourceId, at);
  }

  const untrashed: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^manifest-(.+)\.json$/.exec(name);
    if (!m || !STEM_RE.test(m[1]) || isTrashed(dir, m[1])) continue;
    const sourceId = sourceIdFromManifest(dir, m[1]);
    if (sourceId) untrashed.push(sourceId);
  }
  let cleared = 0;
  if (untrashed.length > 0) {
    const rows = await db
      .update(schema.recordings)
      .set({ trashedAt: null })
      .where(
        and(
          eq(schema.recordings.source, CLIPWISE_SOURCE),
          inArray(schema.recordings.sourceId, untrashed),
          isNotNull(schema.recordings.trashedAt),
        ),
      )
      .returning({ id: schema.recordings.id });
    cleared = rows.length;
  }
  return { marked, cleared };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = argv[0] && !argv[0].startsWith("--") ? resolve(argv[0]) : null;
  const action = argv[1];
  const stems: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--stem" && i + 1 < argv.length) stems.push(argv[++i]);
    else {
      process.stderr.write(`trash: unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }
  if (!dir || !["trash", "restore", "delete"].includes(action) || stems.length === 0) {
    process.stderr.write(
      "usage: tsx src/pipeline/trash.ts <capture_dir> trash|restore|delete --stem <stem> [--stem <stem> ...]\n",
    );
    process.exit(2);
  }

  let failed = 0;
  for (const stem of stems) {
    try {
      const detail =
        action === "trash"
          ? await trashCapture(dir, stem)
          : action === "restore"
            ? await restoreCapture(dir, stem)
            : await deleteCapture(dir, stem);
      process.stdout.write(`TRASH_RESULT ${JSON.stringify({ action, stem, ok: true, ...detail })}\n`);
    } catch (err) {
      failed++;
      const code = err instanceof TrashError ? err.code : "error";
      // A TrashError's message is ours (already scrubbed where it wraps a
      // database error); anything else goes through describeErrorLine.
      const message = err instanceof TrashError ? err.message : describeErrorLine(err);
      process.stdout.write(`TRASH_RESULT ${JSON.stringify({ action, stem, ok: false, code, message })}\n`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

// Only when run as a CLI — importing this module (recover.ts does) must not
// run it.
if (process.argv[1] && /(^|[\\/])trash\.(ts|js)$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      process.stderr.write(`trash: ${describeErrorLine(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
