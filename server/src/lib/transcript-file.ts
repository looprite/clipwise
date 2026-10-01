// The saved transcript file (SAA-199): one recording's transcript as plain
// text in the layout Tyler's routine already starts from — a title line, a
// date and length line, a rule, then one block per turn:
//
//   M:SS - Name
//     what was said
//
// Pure: takes what readTranscript returns plus the recording's own fields and
// returns the text, so it can be checked on made-up samples.
//
// Who gets which label (SAA-165's correct-or-absent rule — a line is under a
// person's name only if that person was named, otherwise under a label that
// cannot be mistaken for a person, because Tyler's Claude turns this text
// into owners and action items):
//   - a speaker with a display name       -> that name
//   - a `Voice N` row with no name        -> "Unnamed voice N"
//   - `them` with no name, no voices      -> "Unnamed voice N" (one unnamed
//     split into voices                      other party), numbered after the
//                                            voices so numbers never repeat
//   - `them` left over when the call was  -> "Unattributed": diarization found
//     split into voices                      voices, but no voice covers more
//                                            than half of this line, so it is
//                                            deliberately under none of them
//   - `me` with no name                   -> the recording's host attendee, when
//                                            that row has a name (the mic is the
//                                            host — Decision 5, and what
//                                            applySpeakerNames does too); else
//                                            "Unnamed voice N" (next free N)
//   - no speaker row at all               -> "Unattributed"
// Never "me", "them" or "Voice N" as a speaker, even if a display name was
// typed as one of those.

export type FileSegment = {
  startSec: number;
  endSec: number;
  text: string;
  speakerLabel: string | null;
  speakerDisplayName: string | null;
};

export type FileInput = {
  title: string | null;
  // The recording's host attendee name, if it has one. Only used for a `me`
  // speaker row that carries no display name of its own.
  hostName?: string | null;
  startedAt: Date | null;
  durationSec: number | null;
  segments: FileSegment[];
};

export const UNATTRIBUTED = "Unattributed";

const VOICE_LABEL = /^Voice (\d+)$/;
// Not a name: the recorder's own labels, if one was ever stored as a display name.
const NOT_A_NAME = /^(me|them|voice \d+|unattributed|unnamed voice \d+)$/i;

// The recorder's own placeholder title for a capture with no calendar match.
const AUTO_TITLE = /^Clipwise capture — /;

export function displayTitle(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  return t && !AUTO_TITLE.test(t) ? t : "Untitled";
}

function cleanName(name: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  return n && !NOT_A_NAME.test(n) ? n : null;
}

// One resolved name per speaker label present in the segments.
export function resolveSpeakerNames(segments: FileSegment[], hostName?: string | null): Map<string | null, string> {
  const named = new Map<string | null, string | null>();
  for (const s of segments) {
    if (!named.has(s.speakerLabel)) named.set(s.speakerLabel, cleanName(s.speakerDisplayName));
    else if (named.get(s.speakerLabel) === null) named.set(s.speakerLabel, cleanName(s.speakerDisplayName));
  }
  const labels = [...named.keys()];
  const hasVoices = labels.some((l) => l !== null && VOICE_LABEL.test(l));
  const used = new Set<number>();
  for (const l of labels) {
    const m = l === null ? null : VOICE_LABEL.exec(l);
    if (m) used.add(Number(m[1]));
  }
  const nextFree = () => {
    let n = 1;
    while (used.has(n)) n++;
    used.add(n);
    return n;
  };

  const out = new Map<string | null, string>();
  // Voices first (their own numbers), then `them`, then `me`.
  const order = (l: string | null) => (l !== null && VOICE_LABEL.test(l) ? 0 : l === "them" ? 1 : l === "me" ? 2 : 3);
  for (const label of labels.sort((a, b) => order(a) - order(b))) {
    const name = named.get(label) ?? null;
    if (name) { out.set(label, name); continue; }
    const m = label === null ? null : VOICE_LABEL.exec(label);
    if (m) out.set(label, `Unnamed voice ${m[1]}`);
    else if (label === "them") out.set(label, hasVoices ? UNATTRIBUTED : `Unnamed voice ${nextFree()}`);
    else if (label === "me") out.set(label, cleanName(hostName) ?? `Unnamed voice ${nextFree()}`);
    else out.set(label, UNATTRIBUTED);
  }
  return out;
}

// M:SS under an hour (no leading zero on minutes, as in the reference);
// H:MM:SS from an hour on.
export function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export type Turn = { startSec: number; name: string; text: string };

export function buildTurns(segments: FileSegment[], hostName?: string | null): Turn[] {
  const names = resolveSpeakerNames(segments, hostName);
  // Both tracks interleaved by start time; ties keep the stored order.
  const ordered = segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.text.replace(/\s+/g, " ").trim().length > 0)
    .sort((a, b) => a.s.startSec - b.s.startSec || a.s.endSec - b.s.endSec || a.i - b.i);
  const turns: Turn[] = [];
  for (const { s } of ordered) {
    const name = names.get(s.speakerLabel) ?? UNATTRIBUTED;
    const text = s.text.replace(/\s+/g, " ").trim();
    const last = turns[turns.length - 1];
    if (last && last.name === name) last.text += " " + text;
    else turns.push({ startSec: s.startSec, name, text });
  }
  return turns;
}

function dateParts(d: Date, timeZone?: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "long", day: "numeric" });
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return { long: f.format(d), iso: iso.format(d) };
}

export function formatMinutes(durationSec: number): string {
  const n = Math.max(1, Math.round(durationSec / 60));
  return n === 1 ? "1 min" : `${n} mins`;
}

export function formatTranscriptFile(input: FileInput, timeZone?: string): string {
  const turns = buildTurns(input.segments, input.hostName);
  const lastEnd = input.segments.reduce((m, s) => Math.max(m, s.endSec), 0);
  const duration = input.durationSec && input.durationSec > 0 ? input.durationSec : lastEnd;
  const when = input.startedAt ? `${dateParts(input.startedAt, timeZone).long} · ` : "";
  const header = [displayTitle(input.title), `${when}${formatMinutes(duration)}`, "", "---", ""];
  const body = turns.map((t) => `${formatTimestamp(t.startSec)} - ${t.name}\n  ${t.text}`);
  return header.join("\n") + "\n" + body.join("\n\n") + "\n";
}

// "YYYY-MM-DD <title> – transcript.txt", safe to save anywhere.
export function suggestedFileName(input: Pick<FileInput, "title" | "startedAt">, timeZone?: string): string {
  const date = input.startedAt ? dateParts(input.startedAt, timeZone).iso : "undated";
  const title = displayTitle(input.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${date} ${title} – transcript.txt`;
}
