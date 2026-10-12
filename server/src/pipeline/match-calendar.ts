// Matches a capture to a calendar event (SAA-115 step 3, before the
// writes). Runs as the pipeline's first step, ahead of transcribe — see
// run-capture.ts — so a matched event's attendee names are reachable
// before transcription runs, not only written to the database at ingest.
//
// The matching rule below is settled and measured against 22 real captures
// (2026-09-17 dry run): start alignment, never overlap or containment,
// never originalStartTime, 10-minute threshold. Not being revisited here.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import {
  type CalendarEvent,
  GoogleApiError,
  listEvents,
  refreshAccessToken,
} from "../lib/google-calendar.js";
import { writeCalendarMatch, type CalendarMatch } from "../ingest/calendar-match.js";
import type { CaptureIdentity } from "../ingest/clipwise.js";

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

export type MatchResult = {
  matched: boolean;
  detail: Record<string, unknown>;
};

export type CalendarErrorDetail = { calendar_id: string; status: number | null; message: string };

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
    const refreshed = await refreshAccessToken(decrypt(connection.refreshToken));
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
      listEvents(accessToken, calendarId, windowStart, windowEnd).then((events) => ({
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
  // same in the sidecar.
  const calendarErrors: CalendarErrorDetail[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const calendarId = searchedCalendarIds[i];
    if (outcome.status === "fulfilled") {
      events.push(...outcome.value.events);
    } else {
      const err = outcome.reason;
      const status = err instanceof GoogleApiError ? err.status : null;
      const message = err instanceof Error ? err.message : String(err);
      calendarErrors.push({ calendar_id: calendarId, status, message });
      process.stdout.write(
        `calendar-match: WARNING calendar fetch failed calendar=${calendarId} ` +
          `status=${status ?? "(n/a)"} — ${message}\n`,
      );
    }
  }
  return { events, calendarErrors };
}

export async function matchCaptureToCalendar(
  dir: string,
  stem: string,
  capture: CaptureIdentity,
  ownerMemberId: string,
): Promise<MatchResult> {
  const resolved = await resolveCalendarConnection(ownerMemberId);
  if ("reason" in resolved) {
    return { matched: false, detail: { reason: resolved.reason } };
  }
  const { connection, accessToken } = resolved;

  const searchedCalendarIds = connection.searchedCalendarIds ?? [];
  if (searchedCalendarIds.length === 0) {
    return { matched: false, detail: { reason: "no_searchable_calendars" } };
  }

  const captureStartedAt = new Date(capture.startedAt);
  const windowStart = new Date(captureStartedAt.getTime() - WINDOW_MS);
  const windowEnd = new Date(captureStartedAt.getTime() + WINDOW_MS);

  const { events, calendarErrors } = await fetchEventsForWindow(
    connection,
    accessToken,
    windowStart,
    windowEnd,
  );

  const result = matchEvent(captureStartedAt, events);
  if (!result) {
    return {
      matched: false,
      detail: {
        reason: "no_event_in_range",
        ...(calendarErrors.length ? { calendar_errors: calendarErrors } : {}),
      },
    };
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
  writeCalendarMatch(dir, stem, match);

  return {
    matched: true,
    detail: {
      event_id: event.id,
      offset_ms: offsetMs,
      invitee_count: invitees.length,
      ...(calendarErrors.length ? { calendar_errors: calendarErrors } : {}),
    },
  };
}
