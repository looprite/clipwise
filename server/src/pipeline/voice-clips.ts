// The naming data for SAA-195's window: for a capture diarize just split
// into 2+ voices, cut a few short single-voice clips from the best-quality
// audio on disk and pull each voice's two longest transcript lines, so the
// recorder can show something to listen to and read without touching the
// database itself (main.js never has DB access — see identity.ts's own
// file-based answer for the same reason, the other direction).
//
// Built from files only: the diarize sidecar and transcript-<stem>.json, keyed by
// voice index, with no database read (SAA-227 decision 2). This module loads no
// database code, so it also runs where there is no DATABASE_URL.
//
// Written only when diarize actually split the recording (2+ voices). A
// two-party call never gets this file, and the naming window never shows a
// step 2 for it.
//
// Clips are recordings, so they stay out of the repo (Architecture
// Decision #11) — same directory as everything else this capture already
// wrote, gitignored by the same rule that covers the rest of that
// directory tree.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ClipRange = { start: number; end: number };

// voiceIndex is null for a diarized segment that exists but was excluded
// (host echo, or under minimumVoiceSeconds — see main.swift). assignVoice
// below no longer treats that differently from no entry at all for a time
// range (a true diarization gap): neither counts toward any voice's
// coverage, and both leave a segment unnamed unless some OTHER real voice
// covers a majority of it regardless.
export type DiarizeSegment = {
  start: number;
  end: number;
  voiceIndex: number | null;
};

// Reassign a `them` segment to the diarized voice whose real turns cover
// MOST of it — majority rule (SAA-199, 2026-09-29), replacing "any positive
// overlap wins." That rule attributed a segment on a sliver of overlap next
// to an otherwise-uncovered stretch: 173.79-177.22 on the 09-28 sync, 10%
// real coverage from one turn ending 0.34s into it, labelled Voice 1 when
// the content is someone else's. A null result means "leave this segment on
// `them`" — no real voice covers a majority of it, whether because nothing
// overlaps it at all (a true gap), only an excluded voice's time range does
// (host echo, or under minimumVoiceSeconds), or several real voices each
// cover a minority (a genuine multi-speaker merge inside one whisper
// segment — see the 430s/442s pair found the same day).
//
// No nearest-distance fallback either. Snapping an uncovered segment onto
// whichever real voice happens to be closest in time is a guess with the
// same shape as the sliver-overlap rule this replaces — proximity is not
// coverage. Absent a majority, the segment goes unnamed.
export const ASSIGN_VOICE_MAJORITY_FRACTION = 0.5;
// Called by diarize.ts's split and by the naming data below.
// recorder/app/identity-answer.js carries a copy for the Mac's capture builder
// (SAA-227 decision 1); check-assign-voice.ts runs both over the same cases.
export function assignVoice(
  segStart: number,
  segEnd: number,
  diarized: DiarizeSegment[],
): number | null {
  const segDuration = segEnd - segStart;
  if (segDuration <= 0) return null;
  // Summed per real voiceIndex, not per individual turn: a segment can span
  // several short turns of the same voice, and each should count toward
  // that voice's total coverage rather than only the single best turn.
  // Excluded-voice turns (`d.voiceIndex` null in the type, or `undefined`
  // at runtime — Swift's JSONEncoder omits a nil Optional key rather than
  // writing `null`, confirmed empirically) are never a candidate to assign
  // onto; their time simply isn't counted toward any real voice's total.
  const overlapByVoice = new Map<number, number>();
  for (const d of diarized) {
    if (d.voiceIndex == null) continue;
    const overlap = Math.min(segEnd, d.end) - Math.max(segStart, d.start);
    if (overlap <= 0) continue;
    overlapByVoice.set(d.voiceIndex, (overlapByVoice.get(d.voiceIndex) ?? 0) + overlap);
  }
  let bestVoice: number | null = null;
  let bestOverlap = 0;
  for (const [voice, overlap] of overlapByVoice) {
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestVoice = voice;
    }
  }
  return bestVoice !== null && bestOverlap > segDuration * ASSIGN_VOICE_MAJORITY_FRACTION
    ? bestVoice
    : null;
}

// --- the tool's sidecar, as diarize (the Swift binary) writes it ----------

export type DiarizeVoice = {
  voiceIndex: number;
  sourceLabel: string;
  totalSeconds: number;
  embedding: number[];
  clipRanges: ClipRange[];
};

export type DiarizeSidecar = {
  model: string;
  modelRevision: string;
  clusteringThreshold: number;
  hostEchoThreshold: number;
  processingTimeSeconds: number;
  voices: DiarizeVoice[];
  segments: DiarizeSegment[];
  hostEchoSourceLabel: string | null;
  hostEchoSimilarity: number | null;
  error: string | null;
  // Added by recorder/transcribe.py when it ran the binary itself (SAA-239);
  // never written by the binary. See readEarlySidecar.
  early_run?: unknown;
};

// The sidecar recorder/transcribe.py leaves when it started the binary early
// (SAA-239), or why it can't be used. It is used only if it says the binary
// exited 0 AND the two wavs it was made from still have the size and mtime it
// recorded; anything else (an older sidecar with no such block, a different
// run's wavs, a wav rewritten since, a garbled file) means the caller runs the
// binary itself, exactly as before. mtime is nanoseconds as a string on both
// sides: a JSON number would lose digits here.
export type EarlySidecar = { sidecar: DiarizeSidecar | null; reason: string };

export function readEarlySidecar(sidecarPath: string, tapWav: string, micWav: string): EarlySidecar {
  let doc: DiarizeSidecar & { early_run?: unknown };
  try {
    doc = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    return { sidecar: null, reason: "no readable sidecar" };
  }
  const er = (doc as { early_run?: unknown } | null)?.early_run as
    | { exit_code?: unknown; tap_wav?: unknown; mic_wav?: unknown }
    | undefined;
  if (!er || typeof er !== "object") return { sidecar: null, reason: "sidecar has no early_run block" };
  if (er.exit_code !== 0) return { sidecar: null, reason: `early run exit status was ${String(er.exit_code)}` };
  for (const [name, path, recorded] of [
    ["tap", tapWav, er.tap_wav],
    ["mic", micWav, er.mic_wav],
  ] as const) {
    const rec = recorded as { size?: unknown; mtime_ns?: unknown } | undefined;
    if (!rec || typeof rec.size !== "number" || typeof rec.mtime_ns !== "string") {
      return { sidecar: null, reason: `early_run has no usable ${name} wav record` };
    }
    let st;
    try {
      st = statSync(path, { bigint: true });
    } catch {
      return { sidecar: null, reason: `${name} wav not readable` };
    }
    if (Number(st.size) !== rec.size || String(st.mtimeNs) !== rec.mtime_ns) {
      return { sidecar: null, reason: `${name} wav differs from the one the early run used` };
    }
  }
  return { sidecar: doc, reason: "early run's wavs unchanged" };
}

// Where the sidecar for this capture comes from: transcribe.py's early run if
// it provably matches these wavs, otherwise `runBinary` (which the caller
// supplies, and which is NOT called when the early sidecar is used). Whatever
// runBinary throws propagates, so the caller's skip-on-failure handling is
// the one it always had.
export function sidecarForCapture(
  sidecarPath: string,
  tapWav: string,
  micWav: string,
  runBinary: () => DiarizeSidecar,
): { sidecar: DiarizeSidecar; usedEarly: boolean; reason: string } {
  const early = readEarlySidecar(sidecarPath, tapWav, micWav);
  if (early.sidecar) return { sidecar: early.sidecar, usedEarly: true, reason: early.reason };
  return { sidecar: runBinary(), usedEarly: false, reason: early.reason };
}

export type NamingVoice = {
  voiceIndex: number;
  clipPaths: string[];
  // The two longest segments attributed to this voice, not the first two
  // (SAA-195's design comment: on 09-14 the first lines were "Yeah…" and
  // "forth on that…" — useless for recognizing someone by ear).
  lines: Array<{ text: string; start: number; end: number }>;
};

export type NamingData = {
  recording_id: string;
  stem: string;
  generated_at: string;
  voices: NamingVoice[];
};

export function namingDataPathFor(dir: string, stem: string): string {
  return join(dir, `voices-${stem}.json`);
}

function clipPathFor(dir: string, stem: string, voiceIndex: number, n: number): string {
  return join(dir, `voice-clip-${stem}-${voiceIndex}-${n}.wav`);
}

// Duplicated from apply-identity.ts's readManifestRecordingId rather than
// imported: this module is reached from the diarize pipeline step, and
// apply-identity.ts pulls in ingest/identity.ts, which pulls in this
// file's own sibling (diarize.ts, for isVoiceLabel) — importing back from
// apply-identity.ts here risks the same circular shape identity.ts's own
// comment already avoids once. One ten-line function is the cheaper side.
function readManifestRecordingId(dir: string, stem: string): string {
  const path = join(dir, `manifest-${stem}.json`);
  const doc = JSON.parse(readFileSync(path, "utf8")) as { recording_id?: string };
  if (!doc.recording_id) throw new Error(`manifest ${path} has no recording_id`);
  return doc.recording_id;
}

// Cuts from system-<stem>.f32le.pcm — the native-rate tap capture, never
// the 16kHz copy diarize itself reads — because these clips are for a
// person to listen to, not a model to analyze. Raw f32le/48kHz/mono input
// framing matches transcribe.py's own ffmpeg_downsample_pcm exactly (the
// only other place this repo reads that file format).
function cutClip(tapPcmPath: string, range: ClipRange, outPath: string): void {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "f32le", "-ar", "48000", "-ac", "1",
    "-i", tapPcmPath,
    "-ss", String(range.start), "-to", String(range.end),
    "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", "-c:a", "pcm_s16le", "-f", "wav",
    outPath,
  ]);
}

// The transcript's segments, as transcribe.py writes transcript-<stem>.json.
type TranscriptSegment = { track: string; start_ms: number; end_ms: number; text: string };

// Called from diarize.ts right after a successful split, with the sidecar the
// split was made from. Best-effort by design, same posture as diarize itself: a
// clip-cutting failure here must not undo the split or fail the capture, so the
// caller wraps this the same way it wraps the diarize tool's own execFileSync.
//
// Each voice's lines are the `them` segments assignVoice gives it, read from the
// transcript file: the same rule, over the same turns, that put those segments on
// the voice's speaker row.
export async function generateVoiceNamingData(
  dir: string,
  stem: string,
  sidecar: { voices: Array<{ voiceIndex: number; clipRanges: ClipRange[] }>; segments: DiarizeSegment[] },
): Promise<string> {
  const tapPcmPath = join(dir, `system-${stem}.f32le.pcm`);
  if (!existsSync(tapPcmPath)) {
    throw new Error(`native tap audio not found at ${tapPcmPath}`);
  }
  const transcript = JSON.parse(readFileSync(join(dir, `transcript-${stem}.json`), "utf8")) as { segments: TranscriptSegment[] };
  const linesByVoice = new Map<number, Array<{ text: string; start: number; end: number }>>();
  for (const s of transcript.segments) {
    if (s.track !== "them") continue;
    const start = s.start_ms / 1000;
    const end = s.end_ms / 1000;
    const voiceIndex = assignVoice(start, end, sidecar.segments);
    if (voiceIndex === null) continue;
    linesByVoice.set(voiceIndex, [...(linesByVoice.get(voiceIndex) ?? []), { text: s.text, start, end }]);
  }

  const namingVoices: NamingVoice[] = [];
  for (const voice of sidecar.voices) {
    const clipPaths: string[] = [];
    for (let i = 0; i < voice.clipRanges.length; i++) {
      const outPath = clipPathFor(dir, stem, voice.voiceIndex, i + 1);
      cutClip(tapPcmPath, voice.clipRanges[i], outPath);
      clipPaths.push(outPath);
    }
    const duration = (l: { start: number; end: number }) => l.end - l.start;
    const lines = (linesByVoice.get(voice.voiceIndex) ?? [])
      .slice()
      .sort((a, b) => duration(b) - duration(a))
      .slice(0, 2);
    namingVoices.push({ voiceIndex: voice.voiceIndex, clipPaths, lines });
  }

  const doc: NamingData = {
    recording_id: readManifestRecordingId(dir, stem),
    stem,
    generated_at: new Date().toISOString(),
    voices: namingVoices,
  };
  const path = namingDataPathFor(dir, stem);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  return path;
}
