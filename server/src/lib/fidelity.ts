import { z } from "zod";

// SAA-78. The fidelity declaration a client must send with every
// transcript payload. Counts MUST be taken off the source's raw
// turn/text fields (Fathom transcript_messages, Whisper segments,
// etc.) BEFORE any parsing or normalization — a client that counts
// from the object it's about to POST will declare its own losses
// and pass its own check. `countedFrom` names the field the count
// was taken from so the next client can either match it or notice
// the mismatch loudly.
export const sourceFidelitySchema = z.object({
  declaredTurnCount: z.number().int().nonnegative(),
  declaredBodyChars: z.number().int().nonnegative(),
  countedFrom: z.string().min(1).max(512),
});

// The fidelity counting rule, applied identically on both sides of
// the check. A declaring client using this same rule against its
// source's raw turn/text fields will produce numbers that match a
// faithful server-side count.
//
// Rule (SAA-78):
//   turnCount = number of turns  (one per source turn = one segment)
//   bodyChars = sum over segments of segment.text.length, where
//               .length is JS String length in UTF-16 code units,
//               with NO trimming, NO whitespace normalization, and
//               NO inclusion of speaker labels or timestamps.
//
// Do not change this rule without updating every declaring client at
// the same time — a rule change on one side without the other
// silently re-enables the failure this check exists to catch.
export function countObservedFidelity(
  segments: { text: string }[],
): { turnCount: number; bodyChars: number } {
  return {
    turnCount: segments.length,
    bodyChars: segments.reduce((n, s) => n + s.text.length, 0),
  };
}
