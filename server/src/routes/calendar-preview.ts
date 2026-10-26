// POST /captures/calendar-preview: who the calendar says a capture that just
// stopped was with, for the identity prompt (SAA-221). A capture token; the
// recorder asks at stop, before the capture is uploaded, so there is no
// recording to read and nothing is written: the match job (pipeline/
// match-calendar.ts) still stores the invitees once the capture is stored.
//
// The body is the capture's start time. The event is found as the match job
// finds it: the caller's own calendar connection, the same window and
// matchEvent's start-alignment rule. The reply:
//   matched   false when there is no connection, no event within the threshold,
//             or Google could not be read; the prompt then shows nothing extra.
//             The log tells these apart: no_searchable_calendars when the
//             connection searches none, no_event_in_range only when every
//             searched calendar was read, calendar_unreadable failed=n/m when
//             any was not
//   title     the event's title
//   named     the names of the invitees a person record in the caller's account
//             names, one the caller may see (personVisibleTo), never their
//             addresses
//   unnamed   the addresses of the rest, for the member to name once
//             (ingest/invitee-names.ts). They are on the caller's own invite
// The owner's own addresses are in neither (invitee-names.ts ownerAddresses),
// nor is an attendee Google marks as the caller (self).
//
// The log line is counts and ids: no title, name or address.

import type { RequestHandler } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { personVisibleTo } from "../access/visibility.js";
import { normalizeEmail } from "../auth/membership.js";
import { db, schema } from "../db/index.js";
import { ownerAddresses } from "../ingest/invitee-names.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import type { CalendarEvent } from "../lib/google-calendar.js";
import { fetchEventsForWindow, matchEvent, resolveCalendarConnection, WINDOW_MS } from "../pipeline/match-calendar.js";

const previewSchema = z.object({ startedAt: z.string().datetime({ offset: true }) }).strict();

export type CalendarPreview = { matched: boolean; title: string | null; named: string[]; unnamed: string[] };

const NONE: CalendarPreview = { matched: false, title: null, named: [], unnamed: [] };

// The event's invitee addresses, normalized and once each, less the owner's own
// and the attendee Google marks as the caller. Pure, for the DB-less check.
export function inviteeAddresses(event: CalendarEvent, owner: Set<string>): string[] {
  const out: string[] = [];
  for (const attendee of event.attendees ?? []) {
    if (!attendee.email || attendee.self) continue;
    const email = normalizeEmail(attendee.email);
    if (owner.has(email) || out.includes(email)) continue;
    out.push(email);
  }
  return out;
}

// Splits the addresses by the people rows found for them: a row with a usable
// name names its address; the rest stay addresses. A name with an @ is not
// used. Pure, for the DB-less check.
export function splitByPeople(addresses: string[], people: Array<{ email: string | null; name: string | null }>): { named: string[]; unnamed: string[] } {
  const nameByEmail = new Map<string, string>();
  for (const p of people) {
    const name = p.name?.trim();
    if (p.email && name && !name.includes("@")) nameByEmail.set(normalizeEmail(p.email), name);
  }
  const named: string[] = [];
  const unnamed: string[] = [];
  for (const email of addresses) {
    const name = nameByEmail.get(email);
    if (!name) unnamed.push(email);
    else if (!named.some((n) => n.toLowerCase() === name.toLowerCase())) named.push(name);
  }
  return { named, unnamed };
}

export const calendarPreviewPost: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const body = parseBody(previewSchema, req);
  const startedAt = new Date(body.startedAt);
  const log = (outcome: string) => console.log(`calendar-preview: member=${ctx.memberId} ${outcome}`);

  let preview: CalendarPreview;
  try {
    const resolved = await resolveCalendarConnection(ctx.memberId);
    if ("reason" in resolved) {
      log(`matched=no reason=${resolved.reason}`);
      res.json(NONE);
      return;
    }
    const { connection, accessToken } = resolved;
    // As matchRecording: nothing to search is its own reason, before any fetch,
    // so no_event_in_range always means at least one calendar was read.
    if ((connection.searchedCalendarIds ?? []).length === 0) {
      log("matched=no reason=no_searchable_calendars");
      res.json(NONE);
      return;
    }
    const { events, calendarErrors } = await fetchEventsForWindow(
      connection,
      accessToken,
      new Date(startedAt.getTime() - WINDOW_MS),
      new Date(startedAt.getTime() + WINDOW_MS),
    );
    const match = matchEvent(startedAt, events);
    if (!match) {
      // No event is a finding only when every searched calendar was read: one
      // that failed may hold it. The reply is the same either way.
      const total = (connection.searchedCalendarIds ?? []).length;
      log(
        calendarErrors.length > 0
          ? `matched=no reason=calendar_unreadable failed=${calendarErrors.length}/${total}`
          : "matched=no reason=no_event_in_range",
      );
      res.json(NONE);
      return;
    }
    const addresses = inviteeAddresses(match.event, ownerAddresses(ctx.email, connection));
    // The account explicitly, as invitee-names.ts scopes by it, beside
    // personVisibleTo (which also checks it).
    const people = addresses.length
      ? await db
          .select({ email: schema.people.email, name: schema.people.name })
          .from(schema.people)
          .where(
            and(
              eq(schema.people.accountId, ctx.accountId),
              personVisibleTo(ctx),
              inArray(sql`lower(${schema.people.email})`, addresses),
            ),
          )
      : [];
    preview = { matched: true, title: match.event.summary ?? null, ...splitByPeople(addresses, people) };
  } catch (err) {
    // The prompt waits on nothing: a failure is no preview, said by its class only.
    log(`matched=no reason=error ${err instanceof Error ? err.name : "error"}`);
    res.json(NONE);
    return;
  }
  log(`matched=yes named=${preview.named.length} unnamed=${preview.unnamed.length}`);
  res.json(preview);
});
