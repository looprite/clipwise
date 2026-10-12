// Voice labels for the diarize split (SAA-194), and the re-exports of the majority
// rule and the sidecar readers from voice-clips.ts. The split itself runs on the
// server, inside POST /captures (routes/captures.ts, SAA-227 decision 4); the Mac
// sends each voice's index and total seconds from the sidecar capture-cli.ts
// leaves. This module loads no database code.
//
// Naming, not yet: a split only ever writes `speakers.label` ("Voice 1", "Voice
// 2", ...), never `displayName`. Naming voices is SAA-195/196.

import { join } from "node:path";

// The majority rule and the sidecar readers live in voice-clips.ts, so the naming
// data and the database-free pipeline (capture-cli.ts) run without loading the
// database module (SAA-227 decisions 2 and 8). Re-exported here, where their
// callers have always found them.
export {
  ASSIGN_VOICE_MAJORITY_FRACTION,
  assignVoice,
  readEarlySidecar,
  sidecarForCapture,
  type DiarizeSegment,
  type DiarizeSidecar,
  type EarlySidecar,
} from "./voice-clips.js";

// Not imported from ingest/identity.ts, which declares the same string:
// identity.ts imports isVoiceLabel from this file for its split-undo logic
// (see its own comment), so importing back from identity.ts here would make
// the two modules circular. Re-declaring one string constant is the cheaper
// side of that trade.
const VOICE_LABEL_PATTERN = /^Voice (\d+)$/;

export function voiceLabel(n: number): string {
  return `Voice ${n}`;
}

export function isVoiceLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && VOICE_LABEL_PATTERN.test(label);
}

export type DiarizationStepResult = {
  applied: boolean;
  reason: string;
  voicesFound: number;
  modelRevision: string | null;
  processingTimeSeconds: number | null;
  hostEcho: { similarity: number; threshold: number } | null;
};

function diarizePathFor(dir: string, stem: string): string {
  return join(dir, `diarize-${stem}.json`);
}

export { diarizePathFor };
