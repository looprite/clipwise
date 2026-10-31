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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AccessContext } from "../access/context.js";
import { normalizeEmail } from "../auth/membership.js";
import { db, schema } from "../db/index.js";
import { decideCreate, nameKey, normalizeName } from "../routes/capture-people.js";
import { sameNamePeople } from "./attendee-people.js";

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
  // A person with no address and the typed name, the only one the caller may
  // see, now given this address (SAA-260 step 2).
  adopted: number;
  // A person that existed with no name, now named.
  named: number;
  // A person that existed with a name already: left as it is.
  kept: number;
  // An owner address, an empty name, or a name with an @.
  refused: number;
  inviteesLinked: number;
  attendeesLinked: number;
};

// For each pair: the person with that address in the account. When there is
// none, the same-name rule over the people the caller may see that have no
// address (SAA-260 step 2): exactly one, and that person gets the address and
// is used (`adopted`); none or two or more, a person is created, as before.
// A person found by address is named when it has no name, never renamed. Then
// this recording's invitee row for the address points at it, and so does the
// guest attendee row carrying the same name, the one the prompt added when the
// name was typed. That link also puts the person on this (private) recording
// at once, so it is not shown to other members as an unattached person
// (access/visibility.ts personVisibleTo).
//
// Names are written through normalizeName and compared through nameKey
// (routes/capture-people.ts). The caller holds attendee-people.ts lockNames
// for these names and addresses.
//
// Idempotent: the same pairs again write nothing new.
export async function applyInviteeNames(
  executor: typeof db | Tx,
  ctx: AccessContext,
  recordingId: string,
  owner: Set<string>,
  pairs: InviteeName[],
): Promise<InviteeNamesApplication> {
  const accountId = ctx.accountId;
  const app: InviteeNamesApplication = { created: 0, adopted: 0, named: 0, kept: 0, refused: 0, inviteesLinked: 0, attendeesLinked: 0 };
  for (const pair of pairs) {
    const email = normalizeEmail(pair.email);
    const name = normalizeName(pair.name);
    // A name with an @ is refused, as before; normalizeName refuses one too.
    if (!name || pair.name.includes("@") || !email.includes("@") || owner.has(email)) {
      app.refused += 1;
      continue;
    }
    const key = nameKey(name) as string;
    const lowerEmail = sql`lower(${schema.people.email})`;
    let [person] = await executor
      .select({ id: schema.people.id, name: schema.people.name })
      .from(schema.people)
      .where(and(eq(schema.people.accountId, accountId), eq(lowerEmail, email)));
    if (!person) {
      const decision = decideCreate(await sameNamePeople(executor, ctx, name, { noEmailOnly: true }));
      if (decision.kind === "reuse") {
        const [adopted] = await executor
          .update(schema.people)
          .set({ email, updatedAt: new Date() })
          .where(and(eq(schema.people.id, decision.personId), isNull(schema.people.email)))
          .returning({ id: schema.people.id, name: schema.people.name });
        if (adopted) {
          person = adopted;
          app.adopted += 1;
        }
      }
    }
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
    } else if (nameKey(person.name) !== key) {
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
    if (nameKey(person.name) === key) {
      const unlinked = await executor
        .select({ id: schema.attendees.id, name: schema.attendees.name })
        .from(schema.attendees)
        .where(and(eq(schema.attendees.recordingId, recordingId), eq(schema.attendees.isHost, false), isNull(schema.attendees.personId)));
      const ids = unlinked.filter((a) => nameKey(a.name) === key).map((a) => a.id);
      if (ids.length > 0) {
        await executor.update(schema.attendees).set({ personId: person.id }).where(inArray(schema.attendees.id, ids));
        app.attendeesLinked += ids.length;
      }
    }
  }
  return app;
}

// Counts only: an address or a name never goes in a log.
export function describeInviteeNames(app: InviteeNamesApplication): string {
  return (
    `created=${app.created} adopted=${app.adopted} named=${app.named} kept=${app.kept} refused=${app.refused} ` +
    `invitees_linked=${app.inviteesLinked} attendees_linked=${app.attendeesLinked}`
  );
}
