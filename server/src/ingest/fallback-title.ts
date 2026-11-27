// The title a call gets when no calendar event names it (SAA-135, SAA-230):
// "Call with <guest>", built from the attendee rows the member's answer wrote.
// The host's own row is left out, and so are the recorder's labels ("them",
// "Voice 2", "Unnamed voice 1", ...: lib/transcript-file.ts cleanName). The app
// that triggered the capture is not used (Jon, 2026-11-26): nobody named is
// just "Call".
//
//   nobody named      Call
//   one               Call with A
//   two               Call with A and B
//   three or more     Call with A, B and 1 other / and N others
//
// The same rule for a work call and a personal one. Pure: ingest/title.ts reads
// the rows and writes the result.

import { cleanName } from "../lib/transcript-file.js";

export type TitleAttendee = { name: string | null; isHost: boolean };

export function fallbackTitleFor(attendees: TitleAttendee[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const a of attendees) {
    if (a.isHost) continue;
    const name = cleanName(a.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length === 0) return "Call";
  if (names.length === 1) return `Call with ${names[0]}`;
  if (names.length === 2) return `Call with ${names[0]} and ${names[1]}`;
  const rest = names.length - 2;
  return `Call with ${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? "other" : "others"}`;
}
