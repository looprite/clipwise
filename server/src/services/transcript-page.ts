// A transcript as text, a page at a time (SAA-226).
//
// The MCP tool used to return the whole transcript as pretty-printed JSON with
// a UUID on every segment: 22 of 117 recordings exceeded claude.ai's ~150,000
// characters per tool result, the largest by nearly six times, and Claude Code's
// cap is lower still (25,000 tokens). Rendered as one short line per segment
// the same recordings are about a third the size, and a page budget bounds the
// rest.
//
// One line per segment, numbered by position:
//     [#12 3:04] Jon Dwyer: the line, whitespace collapsed
// Speaker names come from the same rules as the saved transcript file
// (lib/transcript-file.ts: "Unnamed voice N", "Unattributed"), worked out over
// the WHOLE recording so a name means the same on every page.
//
// Paging is by segment number, not by time: two segments can share a start
// time, and a time cursor would repeat or skip one. Each page says where the
// next begins (`next.fromSegment`), and walking those pointers returns every
// segment exactly once (check-transcript-page.ts). `fromSec` is for jumping in
// — "start where this moment starts" — and finds the first segment still
// running at that second.

import { UNATTRIBUTED, formatTimestamp, resolveSpeakerNames, type FileSegment } from "../lib/transcript-file.js";

export const DEFAULT_PAGE_CHARS = 50_000;
export const MIN_PAGE_CHARS = 1_000;
export const MAX_PAGE_CHARS = 100_000;

export type PageRequest = {
  fromSegment?: number;
  fromSec?: number;
  toSec?: number;
  maxChars?: number;
};

export type Page = {
  totalSegments: number;
  // Length of the whole transcript rendered this way, in characters.
  totalChars: number;
  // Segment numbers of the first and last line shown; null if nothing was.
  first: number | null;
  last: number | null;
  shown: number;
  maxChars: number;
  text: string;
  // Where to ask for the rest, or null when this page reaches the end of what
  // was requested.
  next: { fromSegment: number; fromSec: number } | null;
};

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clampPageChars(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_CHARS;
  return Math.min(MAX_PAGE_CHARS, Math.max(MIN_PAGE_CHARS, Math.floor(requested)));
}

export function pageTranscript(segments: FileSegment[], hostName: string | null, req: PageRequest = {}): Page {
  const names = resolveSpeakerNames(segments, hostName);
  const lines: (string | null)[] = segments.map((s, i) => {
    const text = collapse(s.text);
    if (text === "") return null;
    return `[#${i} ${formatTimestamp(s.startSec)}] ${names.get(s.speakerLabel) ?? UNATTRIBUTED}: ${text}`;
  });
  const totalChars = lines.reduce((n, l) => n + (l === null ? 0 : l.length + 1), 0);
  const maxChars = clampPageChars(req.maxChars);
  const n = segments.length;

  let start = 0;
  if (req.fromSegment !== undefined) {
    start = Math.min(n, Math.max(0, Math.floor(req.fromSegment)));
  } else if (req.fromSec !== undefined) {
    const at = segments.findIndex((s) => s.endSec > req.fromSec!);
    start = at === -1 ? n : at;
  }
  let end = n;
  if (req.toSec !== undefined) {
    const at = segments.findIndex((s, i) => i >= start && s.startSec >= req.toSec!);
    end = at === -1 ? n : at;
  }

  const shownLines: string[] = [];
  let used = 0;
  let first: number | null = null;
  let last: number | null = null;
  let i = start;
  for (; i < end; i++) {
    const line = lines[i];
    if (line === null) continue;
    // Always at least one line, so a single enormous segment cannot stall the walk.
    if (shownLines.length > 0 && used + line.length + 1 > maxChars) break;
    shownLines.push(line);
    used += line.length + 1;
    first ??= i;
    last = i;
  }

  let next: Page["next"] = null;
  for (let j = i; j < end; j++) {
    if (lines[j] !== null) {
      next = { fromSegment: j, fromSec: segments[j].startSec };
      break;
    }
  }
  return { totalSegments: n, totalChars, first, last, shown: shownLines.length, maxChars, text: shownLines.join("\n"), next };
}
