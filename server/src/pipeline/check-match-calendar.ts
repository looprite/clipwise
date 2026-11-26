// Regression check for matchEvent() (SAA-115) against the real numbers
// measured in the 2026-09-17 dry run — five matches and two named
// non-matches, from 22 real captures. Validates the matching rule without
// needing live Google access. Also: a match job's signal reaches the Google
// call (SAA-227 part F).
//
// Usage:
//   tsx src/pipeline/check-match-calendar.ts
//
// Exit code 0: every case reproduces the recorded partition. Nonzero: it
// doesn't, and the mismatching case is printed.

import { matchEvent } from "./match-calendar.js";
import { listEvents, type CalendarEvent } from "../lib/google-calendar.js";

function event(id: string, startIso: string, recurringEventId?: string): CalendarEvent {
  return { id, start: { dateTime: startIso }, recurringEventId };
}

type Case = {
  name: string;
  eventStartIso: string;
  offsetMs: number; // capture.startedAt - event.start, matches the Linear comment's sign
  expectMatch: boolean;
};

// Five real matches, offsets exactly as recorded 2026-09-17.
const CASES: Case[] = [
  { name: "09-08 Weekly Initiative Sync", eventStartIso: "2026-09-08T17:30:00Z", offsetMs: 2000, expectMatch: true },
  { name: "09-10 Jon / Tyler", eventStartIso: "2026-09-10T18:00:00Z", offsetMs: 79000, expectMatch: true },
  { name: "09-10 Mike / Jon", eventStartIso: "2026-09-10T19:00:00Z", offsetMs: 496000, expectMatch: true },
  { name: "09-14 Weekly Initiative Sync", eventStartIso: "2026-09-14T17:00:00Z", offsetMs: 41000, expectMatch: true },
  { name: "09-15 Mike / Jon", eventStartIso: "2026-09-15T19:00:00Z", offsetMs: -9000, expectMatch: true },
  // Smallest non-match: a personal call against a declined event, 17m02s away.
  { name: "smallest non-match (17m02s)", eventStartIso: "2026-09-16T12:00:00Z", offsetMs: 1022000, expectMatch: false },
  // The Slack call: same application, same session as a real match, but
  // 20m02s after the SAME event's start — must not match despite proximity.
  { name: "Slack call, must not match (20m02s)", eventStartIso: "2026-09-14T17:00:00Z", offsetMs: 1202000, expectMatch: false },
];

async function main(): Promise<number> {
  let failures = 0;
  for (const c of CASES) {
    const ev = event("evt-" + c.name, c.eventStartIso);
    const captureStartedAt = new Date(new Date(c.eventStartIso).getTime() + c.offsetMs);
    const result = matchEvent(captureStartedAt, [ev]);
    const matched = result !== null;
    const ok = matched === c.expectMatch && (!matched || result.offsetMs === c.offsetMs);
    process.stdout.write(
      `${ok ? "PASS" : "FAIL"} ${c.name}: expected match=${c.expectMatch}, ` +
        `got match=${matched}${matched ? ` offsetMs=${result!.offsetMs}` : ""}\n`,
    );
    if (!ok) failures += 1;
  }

  // originalStartTime must never be read. A moved instance whose
  // originalStartTime is far from the capture but whose real start is
  // close must still match on start.
  const movedInstance: CalendarEvent = {
    id: "evt-moved",
    start: { dateTime: "2026-09-08T13:30:00Z" },
    originalStartTime: { dateTime: "2026-09-08T13:00:00Z" },
  };
  const movedResult = matchEvent(new Date("2026-09-08T13:30:02Z"), [movedInstance]);
  const movedOk = movedResult !== null && movedResult.offsetMs === 2000;
  process.stdout.write(
    `${movedOk ? "PASS" : "FAIL"} moved instance matches on start, not originalStartTime\n`,
  );
  if (!movedOk) failures += 1;

  // SAA-290: a capture must not end at or before the event's start. Times from
  // c2f6c445 and 657a78dc (2026-11-23), against the 20:00 event.
  const EVENT_2000: CalendarEvent = { id: "evt-2000", start: { dateTime: "2026-11-23T20:00:00Z" } };
  const END_CASES: Array<{ name: string; start: string; end: string | null; expectMatch: boolean }> = [
    { name: "(a) c2f6c445: 19:55:07-19:57:24.796, ended before the 20:00 event", start: "2026-11-23T19:55:07.047Z", end: "2026-11-23T19:57:24.796Z", expectMatch: false },
    { name: "(b) 657a78dc: starts 20:00:59, runs 20 min", start: "2026-11-23T20:00:59.039Z", end: "2026-11-23T20:20:59.039Z", expectMatch: true },
    { name: "(c) starts 9 min early, runs into the event", start: "2026-11-23T19:51:00Z", end: "2026-11-23T20:15:00Z", expectMatch: true },
    { name: "(d) no end time: start rule alone", start: "2026-11-23T19:55:07.047Z", end: null, expectMatch: true },
    { name: "(e) ends exactly at the event's start", start: "2026-11-23T19:55:00Z", end: "2026-11-23T20:00:00Z", expectMatch: false },
  ];
  for (const c of END_CASES) {
    const r = matchEvent(new Date(c.start), [EVENT_2000], c.end ? new Date(c.end) : null);
    const ok = (r !== null) === c.expectMatch;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${c.name}: expected match=${c.expectMatch}, got match=${r !== null}\n`);
    if (!ok) failures += 1;
  }

  // A match job's signal reaches the Google call (SAA-227 part F): aborting it
  // ends a call in flight at once, not at the 5 s timeout. fetch is replaced for
  // this case by one that answers only when its own signal aborts; nothing
  // reaches Google.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      s?.addEventListener("abort", () => reject(s.reason), { once: true });
    })) as typeof fetch;
  const ctl = new AbortController();
  const jobAbort = new Error("check: the job's signal");
  const t0 = Date.now();
  setTimeout(() => ctl.abort(jobAbort), 50);
  // Holds the process open while the call is pending. Without it, a call that
  // ignores the job's signal waits only on AbortSignal.timeout, whose timer does
  // not keep Node alive: the process would exit before this case reports.
  const keepAlive = setTimeout(() => {}, 10_000);
  let outcome = "resolved";
  try {
    await listEvents("check-token", "check-calendar", new Date(0), new Date(1), ctl.signal);
  } catch (err) {
    outcome = err === jobAbort ? "the job's abort" : `another error (${err instanceof Error ? err.name : String(err)})`;
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = realFetch;
  }
  const elapsed = Date.now() - t0;
  const signalOk = outcome === "the job's abort" && elapsed < 1000;
  process.stdout.write(
    `${signalOk ? "PASS" : "FAIL"} the job's signal aborts a Google call in flight at once, not at the timeout: ${outcome} after ${elapsed} ms\n`,
  );
  if (!signalOk) failures += 1;

  const total = CASES.length + 2 + END_CASES.length;
  process.stdout.write(`\n${total - failures}/${total} passed\n`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("check-match-calendar.ts")) {
  // A run that ends without reaching the summary is a failure, not a pass.
  process.exitCode = 1;
  void main().then((code) => process.exit(code));
}
