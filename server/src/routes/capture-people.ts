// What the recorder asks about people (SAA-260 step 1), with its capture token:
//
//   GET /captures/me       the caller's own name, for the identity window's
//                          host line in place of the field it asks today.
//                          { displayName }: account_members.display_name,
//                          trimmed, or null when it is empty or holds an @
//                          (it can: a password login made by the CLI may be
//                          named by its address, auth/cli.ts, and sign-in
//                          copies auth_user.name in, auth/membership.ts).
//   GET /captures/people   people the caller may see (personVisibleTo) whose
//                          name holds ?q=, ignoring case and spacing; most
//                          recently seen first, at most SEARCH_LIMIT. "Seen" is
//                          the latest start of a recording the caller can see
//                          (not trashed), through attendees or invitees, so
//                          another member's private call never moves anyone up.
//                          No q is the most recent people. { people: [{ id,
//                          name }] }: never an address, a date or a count, and
//                          no person whose name holds an @.
//
// Nothing here creates a person. A person is created where it is linked to a
// recording (SAA-260 step 2, at ingest), because one created before that is
// unattached, and an unattached person is visible to every member
// (access/visibility.ts). normalizeName and decideCreate below are the rule step
// 2 uses there; they are pure, with their DB-less check in
// check-capture-people.ts, and no route calls them yet.

import type { RequestHandler } from "express";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { personVisibleTo, recordingVisibleTo } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, parseQuery } from "../lib/http.js";

export const SEARCH_LIMIT = 10;
export const MAX_NAME_LENGTH = 256;

// A name as it is compared and stored: trimmed, every run of whitespace one
// space, Unicode NFC. Null when nothing is left, when it is longer than a
// people.name can hold, or when it holds an @ (an address typed as a name;
// identity data never carries one).
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || name.includes("@")) return null;
  return name;
}

// What two names are compared by: normalizeName, then lower case.
export function nameKey(raw: unknown): string | null {
  const name = normalizeName(raw);
  return name === null ? null : name.toLowerCase();
}

// Text for a LIKE pattern with ESCAPE '\': \, % and _ match only themselves.
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Step 2's same-name rule, given the people the caller may see whose nameKey
// equals the typed one: none, create one; exactly one, use it; two or more,
// link nobody (correct or absent) and create nothing.
export type CreateDecision = { kind: "create" } | { kind: "reuse"; personId: string } | { kind: "leave_unlinked"; count: number };
export function decideCreate(matches: ReadonlyArray<{ id: string }>): CreateDecision {
  const ids = [...new Set(matches.map((m) => m.id))];
  if (ids.length === 0) return { kind: "create" };
  if (ids.length === 1) return { kind: "reuse", personId: ids[0] };
  return { kind: "leave_unlinked", count: ids.length };
}

// The host's name as the recorder may use it: trimmed, or null when empty or
// holding an @.
export function displayNameFor(raw: string | null | undefined): string | null {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name.length === 0 || name.includes("@") ? null : name;
}

export const captureMeGet: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const [row] = await db
    .select({ displayName: schema.accountMembers.displayName })
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.id, ctx.memberId));
  res.json({ displayName: displayNameFor(row?.displayName) });
});

const searchQuerySchema = z.object({ q: z.string().max(MAX_NAME_LENGTH).optional() }).strict();

export const capturePeopleGet: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const query = parseQuery(searchQuerySchema, req);
  const p = schema.people;
  const r = schema.recordings;
  // The typed text compared as names are: whitespace collapsed, lower case. An
  // empty q (or only spaces) matches every name.
  const typed = (query.q ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const comparable = sql`lower(regexp_replace(btrim(${p.name}), '\\s+', ' ', 'g'))`;
  // Correlated on the outer people row. recordingVisibleTo names the recordings
  // table by its own name, so the join uses it unaliased.
  const seen = sql`(
    select max(coalesce(${r.startedAt}, ${r.createdAt}))
    from (
      select ${schema.attendees.recordingId} as recording_id from ${schema.attendees} where ${schema.attendees.personId} = ${p.id}
      union
      select ${schema.invitees.recordingId} as recording_id from ${schema.invitees} where ${schema.invitees.personId} = ${p.id}
    ) as linked
    join ${r} on ${r.id} = linked.recording_id
    where ${r.trashedAt} is null and ${recordingVisibleTo(ctx)}
  )`;
  const rows = await db
    .select({ id: p.id, name: p.name })
    .from(p)
    .where(
      and(
        personVisibleTo(ctx),
        isNotNull(p.name),
        sql`btrim(${p.name}) <> ''`,
        sql`position('@' in ${p.name}) = 0`,
        typed ? sql`${comparable} like ${`%${escapeLike(typed)}%`} escape '\\'` : undefined,
      ),
    )
    .orderBy(sql`${seen} desc nulls last`, sql`lower(btrim(${p.name}))`, p.id)
    .limit(SEARCH_LIMIT);
  res.json({ people: rows.map((row) => ({ id: row.id, name: (row.name ?? "").trim() })) });
});
