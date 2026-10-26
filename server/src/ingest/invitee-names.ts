// Naming an invitee once (SAA-221). The calendar preview at stop
// (routes/calendar-preview.ts) shows the prompt an invitee no person record
// names by address only, and the member may type a name for it. That pairing,
// address and name, comes in POST /captures as `inviteeNames`, outside the
// identity answer: the identity answer carries names only, and it is what
// reaches extraction (SAA-221's 10-22 privacy note). Here the person is created
// or linked by address, so the next call's preview names them.
//
// Nothing is paired that the member did not pair. An address with no typed name
// stays unnamed; a typed guest name is never matched to an address by guessing.
//
// Also here: the addresses that are the owner's own, which neither the preview
// nor this ever names.

import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeEmail } from "../auth/membership.js";
import { db, schema } from "../db/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type InviteeName = { email: string; name: string };

// The owner's own addresses: their sign-in address, their calendar
// connection's address, and every calendar the connection searches whose id is
// an address. The last is what leaves out jd@leadiq.com, a calendar shared into
// the jd@quorom.io grant. It also leaves out the owner of any teammate's
// calendar shared in and searched.
export function ownerAddresses(
  memberEmail: string,
  connection: { calendarEmail: string; searchedCalendarIds: string[] | null } | null,
): Set<string> {
  const out = new Set([normalizeEmail(memberEmail)]);
  if (connection) {
    out.add(normalizeEmail(connection.calendarEmail));
    for (const id of connection.searchedCalendarIds ?? []) {
      if (id.includes("@")) out.add(normalizeEmail(id));
    }
  }
  return out;
}

export async function ownerAddressesFor(executor: typeof db | Tx, memberId: string, memberEmail: string): Promise<Set<string>> {
  const [connection] = await executor
    .select({ calendarEmail: schema.calendarConnections.calendarEmail, searchedCalendarIds: schema.calendarConnections.searchedCalendarIds })
    .from(schema.calendarConnections)
    .where(eq(schema.calendarConnections.memberId, memberId));
  return ownerAddresses(memberEmail, connection ?? null);
}

export type InviteeNamesApplication = {
  created: number;
  // A person that existed with no name, now named.
  named: number;
  // A person that existed with a name already: left as it is.
  kept: number;
  // An owner address, an empty name, or a name with an @.
  refused: number;
  inviteesLinked: number;
  attendeesLinked: number;
};

// For each pair: the person with that address in the account, created when
// there is none, named when it has no name, never renamed. Then this
// recording's invitee row for the address points at it, and so does the guest
// attendee row carrying the same name, the one the prompt added when the name
// was typed. That link also puts the person on this (private) recording at
// once, so it is not shown to other members as an unattached person
// (access/visibility.ts personVisibleTo).
//
// Idempotent: the same pairs again write nothing new.
export async function applyInviteeNames(
  executor: typeof db | Tx,
  accountId: string,
  recordingId: string,
  owner: Set<string>,
  pairs: InviteeName[],
): Promise<InviteeNamesApplication> {
  const app: InviteeNamesApplication = { created: 0, named: 0, kept: 0, refused: 0, inviteesLinked: 0, attendeesLinked: 0 };
  for (const pair of pairs) {
    const email = normalizeEmail(pair.email);
    const name = pair.name.trim();
    if (!name || name.includes("@") || !email.includes("@") || owner.has(email)) {
      app.refused += 1;
      continue;
    }
    const lowerEmail = sql`lower(${schema.people.email})`;
    let [person] = await executor
      .select({ id: schema.people.id, name: schema.people.name })
      .from(schema.people)
      .where(and(eq(schema.people.accountId, accountId), eq(lowerEmail, email)));
    if (!person) {
      const [inserted] = await executor
        .insert(schema.people)
        .values({ accountId, email, name })
        .onConflictDoNothing({ target: [schema.people.accountId, schema.people.email] })
        .returning({ id: schema.people.id, name: schema.people.name });
      if (inserted) {
        person = inserted;
        app.created += 1;
      } else {
        [person] = await executor
          .select({ id: schema.people.id, name: schema.people.name })
          .from(schema.people)
          .where(and(eq(schema.people.accountId, accountId), eq(lowerEmail, email)));
      }
    } else if (!person.name?.trim()) {
      await executor.update(schema.people).set({ name, updatedAt: new Date() }).where(eq(schema.people.id, person.id));
      person = { ...person, name };
      app.named += 1;
    } else if (person.name.trim().toLowerCase() !== name.toLowerCase()) {
      app.kept += 1;
    }
    if (!person) continue;

    const invitees = await executor
      .update(schema.invitees)
      .set({ personId: person.id })
      .where(and(eq(schema.invitees.recordingId, recordingId), eq(sql`lower(${schema.invitees.email})`, email), isNull(schema.invitees.personId)))
      .returning({ id: schema.invitees.id });
    app.inviteesLinked += invitees.length;

    // Only the attendee the member named: the person's name and the typed one
    // agree. A person kept under another name is linked by address only.
    if ((person.name ?? "").trim().toLowerCase() === name.toLowerCase()) {
      const attendees = await executor
        .update(schema.attendees)
        .set({ personId: person.id })
        .where(
          and(
            eq(schema.attendees.recordingId, recordingId),
            eq(schema.attendees.isHost, false),
            isNull(schema.attendees.personId),
            eq(sql`lower(trim(${schema.attendees.name}))`, name.toLowerCase()),
          ),
        )
        .returning({ id: schema.attendees.id });
      app.attendeesLinked += attendees.length;
    }
  }
  return app;
}

// Counts only: an address or a name never goes in a log.
export function describeInviteeNames(app: InviteeNamesApplication): string {
  return (
    `created=${app.created} named=${app.named} kept=${app.kept} refused=${app.refused} ` +
    `invitees_linked=${app.inviteesLinked} attendees_linked=${app.attendeesLinked}`
  );
}
