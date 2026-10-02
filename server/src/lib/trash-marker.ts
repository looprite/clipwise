// The Mac-side half of a recording's trashed state (SAA-154): a marker file,
// trashed-<stem>.json, beside the capture's other files. The recorder's
// windows, the "Save transcript" item and the recovery pass all read files
// (main.js has no database access), so the marker is what they check. The
// database's recordings.trashed_at is the same fact for Claude's tools.
//
// No database import here, so a check can use it without a connection. The
// recorder's JavaScript (last-meeting.js) reads the same file name; keep the
// two in step.

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STEM_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export type TrashMarker = {
  stem: string;
  // The manifest's recording_id, which ingest files the row under as
  // source_id (the manifest's own, else the stem — ingest/clipwise.ts).
  source_id: string;
  trashed_at: string;
};

export function markerPath(dir: string, stem: string): string {
  return join(dir, `trashed-${stem}.json`);
}

export function readMarker(dir: string, stem: string): TrashMarker | null {
  try {
    const doc = JSON.parse(readFileSync(markerPath(dir, stem), "utf8")) as Partial<TrashMarker>;
    if (typeof doc.source_id !== "string" || typeof doc.trashed_at !== "string") return null;
    return { stem, source_id: doc.source_id, trashed_at: doc.trashed_at };
  } catch {
    return null;
  }
}

// A marker that exists but will not parse still counts as trashed: the
// person's intent was written, and failing open would show it again.
export function isTrashed(dir: string, stem: string): boolean {
  return existsSync(markerPath(dir, stem));
}

export function trashedStems(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^trashed-(.+)\.json$/.exec(name);
    if (m && STEM_RE.test(m[1])) out.push(m[1]);
  }
  return out.sort();
}

// Written whole or not at all: a half-written marker would read as no marker.
export function writeMarker(dir: string, marker: TrashMarker): void {
  const tmp = markerPath(dir, marker.stem) + ".tmp";
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, markerPath(dir, marker.stem));
}

export function removeMarker(dir: string, stem: string): void {
  rmSync(markerPath(dir, stem), { force: true });
}

// Every file a capture leaves in the directory, by name: <kind>-<stem>.<ext>,
// <kind>-<stem>.log, voice-clip-<stem>-<n>-<n>.wav. The stem is a fixed-width
// timestamp, so "-<stem>" followed by "." or "-" cannot match another capture.
export function captureFiles(dir: string, stem: string): string[] {
  const needle = `-${stem}`;
  return readdirSync(dir).filter((name) => {
    const i = name.indexOf(needle);
    if (i < 0) return false;
    const next = name[i + needle.length];
    return next === "." || next === "-" || next === undefined;
  });
}
