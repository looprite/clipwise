// Splits the call-audio (`them`) track into per-voice labels after a
// capture (SAA-194). Runs as its own pipeline step, after ingest and before
// extract — deliberately not folded into ingest/clipwise.ts. ingest creates
// the plain me/them rows exactly as it always has; this is a separate later
// pass that queries what ingest already wrote and updates it, the same
// shape apply-identity.ts already uses for identity answers that arrive
// after ingest (SAA-179). That keeps ingest's own transaction untouched and
// composes for free with recover.ts's existing per-step retry machinery via
// a named STEP_ORDER entry, rather than needing new logic bolted into the
// insert path.
//
// Naming, not yet: this only ever writes `speakers.label` ("Voice 1", "Voice
// 2", ...), never `displayName`. Naming voices is SAA-195/196. Leaving
// displayName null here is what keeps extract.ts's loadIdentityResolved (it
// treats ANY non-null displayName as "identity resolved for this recording")
// from being tripped by a voice split — a group call stays exactly as
// unresolved as it is today.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { generateVoiceNamingData, type ClipRange } from "./voice-clips.js";

// Not imported from ingest/identity.ts, which declares the same two
// strings: identity.ts imports isVoiceLabel from this file for its
// split-undo logic (see its own comment), so importing back from identity.ts
// here would make the two modules circular. Re-declaring one string
// constant is the cheaper side of that trade.
const GUEST_LABEL = "them";
const VOICE_LABEL_PATTERN = /^Voice (\d+)$/;

export function voiceLabel(n: number): string {
  return `Voice ${n}`;
}

export function isVoiceLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && VOICE_LABEL_PATTERN.test(label);
}

// --- the tool's sidecar, as diarize (the Swift binary) writes it ----------

type DiarizeVoice = {
  voiceIndex: number;
  sourceLabel: string;
  totalSeconds: number;
  embedding: number[];
  clipRanges: ClipRange[];
};

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

type DiarizeSidecar = {
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

export type DiarizationStepResult = {
  applied: boolean;
  reason: string;
  voicesFound: number;
  modelRevision: string | null;
  processingTimeSeconds: number | null;
  hostEcho: { similarity: number; threshold: number } | null;
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

function diarizePathFor(dir: string, stem: string): string {
  return join(dir, `diarize-${stem}.json`);
}

function skip(reason: string, extra: Partial<DiarizationStepResult> = {}): DiarizationStepResult {
  return {
    applied: false,
    reason,
    voicesFound: 0,
    modelRevision: null,
    processingTimeSeconds: null,
    hostEcho: null,
    ...extra,
  };
}

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
// Exported for the dry-run comparison this rule was verified against
// (2026-09-29, against the removed sliver-overlap/nearest-fallback rule and
// against the Fathom ground-truth file) — not called from outside this
// module in the pipeline itself.
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

export async function runDiarizationForCapture(
  dir: string,
  stem: string,
  dbRecordingId: string,
): Promise<DiarizationStepResult> {
  // Cheapest check first, before anything else — including the DB round
  // trip below. No attempt to build or exec anything Intel-side is ever
  // made (SAA-194 §6).
  if (process.arch !== "arm64") {
    return skip(`Apple Silicon only — this Mac reports process.arch=${process.arch}`);
  }

  const them = await db
    .select({ id: schema.speakers.id, displayName: schema.speakers.displayName })
    .from(schema.speakers)
    .where(and(eq(schema.speakers.recordingId, dbRecordingId), eq(schema.speakers.label, GUEST_LABEL)));
  if (them.length === 0) {
    return skip("no `them` speaker row on this recording — nothing to split (e.g. a tap-only track with no audio)");
  }

  const existingLabels = await db
    .select({ label: schema.speakers.label })
    .from(schema.speakers)
    .where(eq(schema.speakers.recordingId, dbRecordingId));
  if (existingLabels.some((s) => isVoiceLabel(s.label))) {
    return skip("already split by a prior diarize pass — not idempotent to re-run");
  }

  // Three levels up lands at the repo root from either src/pipeline (tsx) or
  // dist/pipeline (built) — same resolution rule transcribeIfMissing uses.
  // Checkout-relative on purpose: the server pipeline always runs from a
  // full checkout (dev via tsx, or the packaged app's SERVER_DIR, which
  // main.js points at the building machine's own checkout — see
  // build-app.sh's build-info.json), never from inside Clipwise.app. The
  // app-bundle copy under Contents/Resources exists for the CC-BY-4.0
  // redistribution requirement and packaging parity with systemtap/miccap,
  // not because the pipeline reads it from there.
  const diarizeBin = resolve(__dirname, "..", "..", "..", "recorder", "diarize", ".build", "release", "diarize");
  const modelsParentDir = resolve(__dirname, "..", "..", "..", "recorder", "diarize", "models");
  if (!existsSync(diarizeBin)) {
    return skip(`recorder/diarize binary not found at ${diarizeBin} (run recorder/diarize/fetch-models.sh and swift build)`);
  }

  const tapWav = join(dir, `system-${stem}.16k.wav`);
  const micWav = join(dir, `mic-${stem}.16k.wav`);
  if (!existsSync(tapWav)) {
    return skip(`tap 16k wav not found at ${tapWav} — transcribe step may not have run`);
  }

  const sidecarPath = diarizePathFor(dir, stem);
  let sidecar: DiarizeSidecar;
  try {
    // transcribe.py starts the binary right after downsampling and leaves its
    // sidecar here (SAA-239); it is used only if it provably came from these
    // wavs, otherwise the binary runs as it always did.
    const got = sidecarForCapture(sidecarPath, tapWav, micWav, () => {
      // Experiment C ran in single-digit seconds on 19-30 minute calls
      // (~400x real time) — 120s is a wide margin over that, not a tuned
      // budget, so a genuinely hung process still gets killed within one
      // capture's processing window rather than blocking recovery forever.
      // A timeout throws (Node sets err.killed/err.signal on it), which the
      // catch below treats the same as any other tool failure: a skip, never
      // a pipeline failure.
      execFileSync(diarizeBin, [tapWav, micWav, modelsParentDir, sidecarPath], {
        stdio: "inherit",
        timeout: 120_000,
      });
      return JSON.parse(readFileSync(sidecarPath, "utf8")) as DiarizeSidecar;
    });
    sidecar = got.sidecar;
    console.log(
      got.usedEarly
        ? `diarize: using the sidecar from transcribe.py's early run (${got.reason})`
        : `diarize: ran the binary (${got.reason})`,
    );
  } catch (err) {
    const timedOut = Boolean(err && typeof err === "object" && "killed" in err && (err as { killed?: boolean }).killed);
    const message = err instanceof Error ? err.message : String(err);
    return skip(timedOut ? "diarize tool timed out after 120s" : `diarize tool failed: ${message}`);
  }

  if (sidecar.error) {
    return skip(`diarize tool reported an error: ${sidecar.error}`);
  }

  // Loose inequality is deliberate: Swift's JSONEncoder omits a nil Optional
  // key entirely rather than writing `null` (confirmed empirically — the
  // 09-14 sidecar, which has no host echo, has no hostEchoSourceLabel key at
  // all), so JSON.parse yields `undefined`, not `null`, for "no host echo
  // found." `!== null` alone would have read that as a host echo with an
  // undefined similarity.
  const hostEcho =
    sidecar.hostEchoSourceLabel != null && sidecar.hostEchoSimilarity != null
      ? { similarity: sidecar.hostEchoSimilarity, threshold: sidecar.hostEchoThreshold }
      : null;

  if (sidecar.voices.length <= 1) {
    // Two-party gating (SAA-194 §5): a real 1:1 call must behave exactly as
    // today. Nothing is written — the single `them` row stands.
    return skip(
      `${sidecar.voices.length} voice(s) survived the host-echo and minimum-size drops — treating as two-party, not splitting`,
      { voicesFound: sidecar.voices.length, modelRevision: sidecar.modelRevision, processingTimeSeconds: sidecar.processingTimeSeconds, hostEcho },
    );
  }

  if (them[0].displayName) {
    // Identity vs. diarization disagreement (SAA-194, addition 1), the
    // "identity resolved before diarize ran" half. ingest/clipwise.ts's
    // applySpeakerNames can name `them` inside the same ingest step that
    // runs just before this one — if it already did, that's a confirmed
    // exactly-one-guest answer, which outranks an unassisted voice count.
    // Splitting now would both contradict that answer and destroy the name
    // it just wrote. The other half — identity arriving AFTER a split has
    // already happened — is handled by applySpeakerNames itself in
    // ingest/identity.ts, which is the only place that sees a late answer.
    return skip(
      `identity already named \`them\`=${JSON.stringify(them[0].displayName)} (one guest); diarization found ` +
        `${sidecar.voices.length} voices — keeping the single \`them\` row, not splitting (disagreement logged, not resolved)`,
      { voicesFound: sidecar.voices.length, modelRevision: sidecar.modelRevision, processingTimeSeconds: sidecar.processingTimeSeconds, hostEcho },
    );
  }

  // Populated inside the transaction, read after it commits — by
  // generateVoiceNamingData, which needs each voice's real speakers.id and
  // must not run until the split it depends on has actually landed.
  let speakerIdByVoiceOut = new Map<number, string>();

  await db.transaction(async (tx) => {
    // Voice embeddings (sidecar.voices[*].embedding) stay on the Mac, in
    // diarize-<stem>.json, and go no further (SAA-194, addition 2). `db`
    // here is Neon-hosted Postgres, not local storage — only the label,
    // voice index and segment times below ever reach it. Nothing inserted
    // in this transaction references `voice.embedding`; `speakers` has no
    // column that could hold one even by mistake.
    const speakerIdByVoice = new Map<number, string>();
    for (const voice of sidecar.voices) {
      const [inserted] = await tx
        .insert(schema.speakers)
        .values({ recordingId: dbRecordingId, label: voiceLabel(voice.voiceIndex) })
        .returning({ id: schema.speakers.id });
      speakerIdByVoice.set(voice.voiceIndex, inserted.id);
    }

    const themSegments = await tx
      .select({ id: schema.segments.id, startSec: schema.segments.startSec, endSec: schema.segments.endSec })
      .from(schema.segments)
      .where(eq(schema.segments.speakerId, them[0].id));

    // A segment can legitimately stay on `them`: assignVoice returns null
    // both for a genuinely excluded voice's time range (host echo, or under
    // minimumVoiceSeconds — see main.swift's SegmentOut comment) and, if it
    // ever happened, no diarized coverage anywhere. Track whether that
    // happened at least once — it decides whether `them` is still needed
    // below.
    let anySegmentKeptOnThem = false;
    for (const seg of themSegments) {
      const voiceIndex = assignVoice(seg.startSec, seg.endSec, sidecar.segments);
      if (voiceIndex === null) {
        anySegmentKeptOnThem = true;
        continue;
      }
      const speakerId = speakerIdByVoice.get(voiceIndex);
      if (!speakerId) {
        anySegmentKeptOnThem = true;
        continue; // unreachable in practice: assignVoice only returns indices present in sidecar.voices
      }
      await tx.update(schema.segments).set({ speakerId }).where(eq(schema.segments.id, seg.id));
    }

    // Only delete the blanket `them` row when nothing was deliberately kept
    // on it (matches ingest's own stated invariant — "a `them` speaker with
    // no segments would assert a participant who contributed nothing",
    // clipwise.ts). Deleting it while a fragment/host-echo voice's segments
    // are still pointed at it would orphan them to a null speakerId via the
    // FK's ON DELETE SET NULL, not leave them on `them` as intended.
    if (!anySegmentKeptOnThem) {
      await tx.delete(schema.speakers).where(eq(schema.speakers.id, them[0].id));
    }

    speakerIdByVoiceOut = speakerIdByVoice;
  });

  // Best-effort, same posture as the diarize tool call above: a naming-data
  // failure (ffmpeg missing, disk full, whatever) must not undo the split
  // that already committed above, and must not fail the capture (SAA-195).
  try {
    await generateVoiceNamingData(
      dir, stem,
      sidecar.voices.map((v) => ({ voiceIndex: v.voiceIndex, clipRanges: v.clipRanges })),
      speakerIdByVoiceOut,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`diarize: naming data generation failed (split still applied): ${message}`);
  }

  return {
    applied: true,
    reason: `split \`them\` into ${sidecar.voices.length} voices`,
    voicesFound: sidecar.voices.length,
    modelRevision: sidecar.modelRevision,
    processingTimeSeconds: sidecar.processingTimeSeconds,
    hostEcho,
  };
}

export { diarizePathFor };
