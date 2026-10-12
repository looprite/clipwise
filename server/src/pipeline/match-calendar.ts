// Matches a stored recording to an event on its owner's calendar and applies
// the match (SAA-115 step 3; SAA-227 part F). Runs on the server as a match job
// (jobs/worker.ts), queued by POST /captures beside extraction when the owner
// has a calendar connected. Extraction reads nothing a match writes, so the two
// run in no set order.
//
// The matching rule below is settled and measured against 22 real captures
// (2026-09-17 dry run): start alignment, never overlap or containment,
// never originalStartTime, 10-minute threshold. Not being revisited here.

import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { LeaseLostError } from "../extract/extract.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import {
  type CalendarEvent,
  GoogleApiError,
  listEvents,
  refreshAccessToken,
} from "../lib/google-calendar.js";
import { applyCalendarMatch, type CalendarMatch, type CalendarMatchApplication } from "../ingest/calendar-match.js";

export const MATCH_THRESHOLD_MS = 10 * 60 * 1000; // settled 2026-09-17, margin both sides

// Pure and unit-tested against the real dry-run numbers (see
// match-calendar.test.ts) — no live Google access needed to validate it.
export function matchEvent(
  captureStartedAt: Date,
  events: CalendarEvent[],
): { event: CalendarEvent; offsetMs: number } | null {
  let best: { event: CalendarEvent; offsetMs: number } | null = null;
  for (const event of events) {
    const startIso = event.start?.dateTime;
    if (!startIso) continue; // all-day events have no time to align on
    // event.start, never event.originalStartTime — the 2026-09-08 moved-
    // instance case: originalStartTime was 13:00, the actual start (and
    // the closest real match, +2s) was 13:30.
    const eventStart = new Date(startIso);
    const offsetMs = captureStartedAt.getTime() - eventStart.getTime();
    const absOffsetMs = Math.abs(offsetMs);
    if (absOffsetMs > MATCH_THRESHOLD_MS) continue;
    if (!best || absOffsetMs < Math.abs(best.offsetMs)) {
      best = { event, offsetMs };
    }
  }
  return best;
}

export type CalendarErrorDetail = { status: number | null };

export type ResolvedConnection = {
  connection: typeof schema.calendarConnections.$inferSelect;
  accessToken: string;
};

// Resolves the calendar connection of the recording's owner, and a usable
// access token — refreshing and persisting a new one if the stored token has
// expired. This is the only side effect: a token refresh is infrastructure
// upkeep, not capture data, and is unconditionally safe to repeat. No event
// data is read or written here.
//
// Only the owner's own connection, never another member's (SAA-227 decision
// 8). A member has at most one: the callback stores only a grant whose primary
// address is the member's own sign-in address (decision 28), and the unique
// index is on (member_id, calendar_email).
//
// Exported so a read-only check (a dry run, a diagnostic) can drive the
// exact same resolution matchCaptureToCalendar uses, rather than a second,
// hand-written copy of it drifting out of sync — the same lesson the title
// placeholder duplication taught earlier in this change.
export async function resolveCalendarConnection(
  ownerMemberId: string,
  signal?: AbortSignal,
): Promise<ResolvedConnection | { reason: "not_connected" }> {
  // First check, deliberately: this is what keeps every capture whose owner
  // has no calendar connected completely unaffected.
  const [connection] = await db
    .select()
    .from(schema.calendarConnections)
    .where(eq(schema.calendarConnections.memberId, ownerMemberId));
  if (!connection) {
    return { reason: "not_connected" };
  }

  let accessToken = decrypt(connection.accessToken);
  if (connection.tokenExpiresAt.getTime() <= Date.now()) {
    const refreshed = await refreshAccessToken(decrypt(connection.refreshToken), signal);
    accessToken = refreshed.accessToken;
    await db
      .update(schema.calendarConnections)
      .set({
        accessToken: encrypt(refreshed.accessToken),
        tokenExpiresAt: refreshed.expiresAt,
      })
      .where(eq(schema.calendarConnections.id, connection.id));
  }

  return { connection, accessToken };
}

// The window queried around the capture's own start. Generous relative to
// the 10-minute match threshold — this is just what's fetched, matchEvent
// still applies the real rule.
const WINDOW_MS = 60 * 60 * 1000;

// Fetches events across every calendar the connection is authorized to
// search, in parallel. No writes of any kind — read-only against Google,
// exported for the same reason resolveCalendarConnection is: so a dry run
// exercises the real resolution rather than a hand-copied approximation.
export async function fetchEventsForWindow(
  connection: typeof schema.calendarConnections.$inferSelect,
  accessToken: string,
  windowStart: Date,
  windowEnd: Date,
  signal?: AbortSignal,
): Promise<{ events: CalendarEvent[]; calendarErrors: CalendarErrorDetail[] }> {
  const searchedCalendarIds = connection.searchedCalendarIds ?? [];

  // In parallel, not sequentially: this step runs ahead of transcribe on
  // every capture, most of which match nothing. N sequential calls at
  // GOOGLE_API_TIMEOUT_MS each would add up to N × that to the common
  // path's worst case — the same silent-stall shape SAA-183 exists to
  // explain. Promise.allSettled keeps worst-case latency at one call's
  // timeout regardless of N, and — unlike Promise.all — a failure on one
  // calendar doesn't discard results already fetched from the others.
  const settled = await Promise.allSettled(
    searchedCalendarIds.map((calendarId) =>
      listEvents(accessToken, calendarId, windowStart, windowEnd, signal).then((events) => ({
        calendarId,
        events,
      })),
    ),
  );

  const events: CalendarEvent[] = [];
  // A stored calendar that fails to fetch is the share-revocation signal
  // the 2026-09-17 comment on the issue predicted ("if it is ever revoked,
  // the feature delivers nothing... while remaining correct for users who
  // own the calendar carrying their own invites"). This is the only place
  // that can be caught, so it's recorded distinctly rather than collapsed
  // into an ordinary no-match — a capture that legitimately has no event
  // and a capture whose calendar access silently broke must not read the
  // same (matchRecording fails the job when every calendar failed).
  const calendarErrors: CalendarErrorDetail[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      events.push(...outcome.value.events);
    } else {
      // The calendar by its place in the list and the status, nothing else: its
      // id is an address, and the error can carry Google's reply (SAA-227
      // decisions 11 and 21).
      const err = outcome.reason;
      const status = err instanceof GoogleApiError ? err.status : null;
      calendarErrors.push({ status });
      process.stdout.write(
        `calendar-match: WARNING calendar fetch failed (calendar ${i + 1} of ${settled.length}) ` +
          `status=${status ?? "(n/a)"} ${err instanceof Error ? err.name : "error"}\n`,
      );
    }
  }
  return { events, calendarErrors };
}

// Every searched calendar failed to answer, so "no event" would be a guess. The
// match job fails and is tried again on the worker's attempts (SAA-227 decision
// 20). The message is counts only: Google's reply stays out of it.
export class CalendarFetchError extends Error {
  constructor(failed: number, total: number) {
    super(`${failed} of ${total} calendar(s) could not be read`);
    this.name = "CalendarFetchError";
  }
}

export type RecordingMatch =
  | { matched: false; reason: "not_connected" | "no_owner" | "no_start_time" | "no_searchable_calendars" | "no_event_in_range" }
  | { matched: true; inviteeCount: number; application: CalendarMatchApplication };

// Matches one stored recording against its owner's calendar, and applies what
// it finds on the server (SAA-227 decisions 10 and 19): the invitees, the
// recurring event id, and the title while it is still the placeholder
// (ingest/calendar-match.ts). Only the owner's connection is used (decision 8).
//
// signal aborts the Google calls in flight (the job's own). With a lease guard
// the apply is fenced like extraction's promotion: in one transaction the job's
// row is locked FOR UPDATE and must still hold this lease in state running.
export async function matchRecording(
  recordingId: string,
  opts: { signal?: AbortSignal; leaseGuard?: { jobId: string; leaseToken: string } } = {},
): Promise<RecordingMatch> {
  const [recording] = await db
    .select({
      accountId: schema.recordings.accountId,
      ownerMemberId: schema.recordings.ownerMemberId,
      startedAt: schema.recordings.startedAt,
      stem: sql<string | null>`${schema.recordings.metadata}->'capture'->>'stem'`,
    })
    .from(schema.recordings)
    .where(eq(schema.recordings.id, recordingId));
  if (!recording) throw new Error("the recording does not exist");
  if (!recording.ownerMemberId) return { matched: false, reason: "no_owner" };

  const resolved = await resolveCalendarConnection(recording.ownerMemberId, opts.signal);
  if ("reason" in resolved) return { matched: false, reason: resolved.reason };
  const { connection, accessToken } = resolved;

  const searchedCalendarIds = connection.searchedCalendarIds ?? [];
  if (searchedCalendarIds.length === 0) return { matched: false, reason: "no_searchable_calendars" };

  // POST /captures always sets it; a row without one has nothing to align on.
  const captureStartedAt = recording.startedAt;
  if (!captureStartedAt) return { matched: false, reason: "no_start_time" };
  const windowStart = new Date(captureStartedAt.getTime() - WINDOW_MS);
  const windowEnd = new Date(captureStartedAt.getTime() + WINDOW_MS);

  const { events, calendarErrors } = await fetchEventsForWindow(connection, accessToken, windowStart, windowEnd, opts.signal);
  opts.signal?.throwIfAborted();

  const result = matchEvent(captureStartedAt, events);
  if (!result) {
    if (calendarErrors.length === searchedCalendarIds.length) {
      throw new CalendarFetchError(calendarErrors.length, searchedCalendarIds.length);
    }
    return { matched: false, reason: "no_event_in_range" };
  }

  const { event, offsetMs } = result;
  const invitees: CalendarMatch["invitees"] = [];
  for (const attendee of event.attendees ?? []) {
    if (!attendee.email) {
      // A resource/room calendar, or a malformed entry. invitees.email is
      // NOT NULL by design — this is skipped, never written with a null.
      process.stdout.write(
        `calendar-match: invitee with no email skipped, event=${event.id}\n`,
      );
      continue;
    }
    invitees.push({
      email: attendee.email,
      name: attendee.displayName ?? null,
      response_status: attendee.responseStatus ?? null,
    });
  }

  const match: CalendarMatch = {
    event_id: event.id,
    title: event.summary ?? null,
    recurring_event_id: event.recurringEventId ?? null,
    invitees,
    offset_ms: offsetMs,
  };

  const guard = opts.leaseGuard;
  const application = await db.transaction(async (tx) => {
    if (guard) {
      const held = await tx
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, guard.jobId), eq(schema.jobs.leaseToken, guard.leaseToken), eq(schema.jobs.state, "running")))
        .for("update");
      if (held.length === 0) throw new LeaseLostError();
    }
    return applyCalendarMatch(tx, recording.accountId, recordingId, recording.stem ?? "", match);
  });

  return { matched: true, inviteeCount: invitees.length, application };
}
