// Attendees stored by person id (SAA-260 step 2). A guest's attendee row points
// at a person, so that fixing a person's name later (step 6) fixes every call
// they were on, and voice recognition (step 3) has someone to enrol.
//
// Where a guest's person comes from, in the order POST /captures applies them:
//   1. the identity answer's guests[].personId, when the window offered one and
//      the caller may see that person (chosenPeople below; step 4's window is
//      the first to send one)
//   2. the invitee the member named once (ingest/invitee-names.ts), by address
//   3. the same-name rule (linkAttendeePeople below), for every guest row still
//      unlinked: the people the caller may see (personVisibleTo) whose name
//      compares equal (nameKey). None: a person is created, in this same
//      transaction, already linked to this recording, so it is never an
//      unattached person (visible to every member). Exactly one: reused. Two or
//      more: the row stays unlinked and nothing is created (correct or absent).
//
// The host line is the member, never a guest person. The host row is never
// linked, and a guest whose name is the host's own (the answer's self name, or
// the member's account display name) stays unlinked: on main a backfilled
// person already carries the member's name, and the rule would reuse it.
//
// attendees.name is left as the answer wrote it. Only people.name is written
// through normalizeName; names are compared through nameKey. The extraction
// speaker fingerprint reads attendees.name and is_host and no person id
// (extract/extract.ts loadSpeakerFingerprint), so linking changes nothing that
// extraction reads, and queues no re-extract.
//
// Concurrency: two captures naming the same new person at once would both find
// no match and both create. lockNames takes a transaction-scoped advisory lock
// per name (and per invitee address) in one sorted pass before any of this
// runs, so the second waits for the first to commit and then finds its person.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AccessContext } from "../access/context.js";
import { personVisibleTo } from "../access/visibility.js";
import { normalizeEmail } from "../auth/membership.js";
import { db, schema } from "../db/index.js";
import { decideCreate, nameKey, normalizeName } from "../routes/capture-people.js";
import type { IdentityAnswer } from "./identity.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The names a guest may not be linked under: the host's own. Pure.
export function hostKeysFor(selfName: unknown, displayName: unknown): Set<string> {
  const keys = new Set<string>();
  for (const raw of [selfName, displayName]) {
    const key = nameKey(raw);
    if (key) keys.add(key);
  }
  return keys;
}

// Whether an attendee row is one the same-name rule may link. Pure.
export function isLinkableGuest(row: { name: string | null; isHost: boolean; personId: string | null }, hostKeys: Set<string>): boolean {
  if (row.isHost || row.personId) return false;
  const key = nameKey(row.name);
  return key !== null && !hostKeys.has(key);
}

// The host keys for a capture: the answer's self name, and the owning member's
// account display name.
export async function hostKeysForCapture(executor: typeof db | Tx, memberId: string, answer: IdentityAnswer | null): Promise<Set<string>> {
  const [member] = await executor
    .select({ displayName: schema.accountMembers.displayName })
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.id, memberId));
  return hostKeysFor(answer?.self?.name, member?.displayName);
}

// One lock per name and per address, taken in sorted order so two
// transactions never wait on each other in a cycle. Held to the transaction's
// end. Taking one twice in the same transaction is harmless.
export async function lockNames(tx: Tx, accountId: string, names: unknown[], emails: string[] = []): Promise<void> {
  const keys = new Set<string>();
  for (const raw of names) {
    const key = nameKey(raw);
    if (key) keys.add(`name:${key}`);
  }
  for (const email of emails) keys.add(`email:${normalizeEmail(email)}`);
  for (const key of [...keys].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`people:${accountId}:${key}`}, 0))`);
  }
}

// The people the caller may see whose name compares equal to `name`, compared
// in JS so that NFC, spacing and case follow nameKey exactly. With
// noEmailOnly, only people without an address (invitee-names' case).
export async function sameNamePeople(
  executor: typeof db | Tx,
  ctx: AccessContext,
  name: string,
  opts: { noEmailOnly?: boolean } = {},
): Promise<Array<{ id: string; name: string | null; email: string | null }>> {
  const key = nameKey(name);
  if (!key) return [];
  const rows = await executor
    .select({ id: schema.people.id, name: schema.people.name, email: schema.people.email })
    .from(schema.people)
    .where(and(personVisibleTo(ctx), opts.noEmailOnly ? isNull(schema.people.email) : undefined));
  return rows.filter((p) => nameKey(p.name) === key);
}

// guests[].personId the caller may see, keyed by the guest's nameKey. A
// personId for a person the caller may not see (another account's, another
// member's private call's, or one deleted since the window) is ignored, and
// that guest is resolved by name instead. One under the host's name is
// ignored too.
export async function chosenPeople(
  executor: typeof db | Tx,
  ctx: AccessContext,
  answer: IdentityAnswer,
  hostKeys: Set<string>,
): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  for (const guest of answer.guests ?? []) {
    const key = nameKey(guest?.name);
    const id = typeof guest?.personId === "string" ? guest.personId : null;
    if (!key || !id || hostKeys.has(key) || wanted.has(key)) continue;
    wanted.set(key, id);
  }
  if (wanted.size === 0) return wanted;
  const visible = await executor
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(and(personVisibleTo(ctx), inArray(schema.people.id, [...new Set(wanted.values())])));
  const ok = new Set(visible.map((p) => p.id));
  for (const [key, id] of wanted) if (!ok.has(id)) wanted.delete(key);
  return wanted;
}

export type AttendeeLinking = {
  created: number;
  reused: number;
  // Two or more people the caller may see share the name.
  leftUnlinked: number;
  // A guest under the host's own name.
  hostNamed: number;
};

// The same-name rule over this recording's unlinked guest rows. Rows that
// share a nameKey get the same person. The caller holds lockNames for these
// names.
export async function linkAttendeePeople(
  tx: Tx,
  ctx: AccessContext,
  recordingId: string,
  hostKeys: Set<string>,
): Promise<AttendeeLinking> {
  const out: AttendeeLinking = { created: 0, reused: 0, leftUnlinked: 0, hostNamed: 0 };
  const rows = await tx
    .select({ id: schema.attendees.id, name: schema.attendees.name, isHost: schema.attendees.isHost, personId: schema.attendees.personId })
    .from(schema.attendees)
    .where(eq(schema.attendees.recordingId, recordingId));
  const byKey = new Map<string, { name: string; ids: string[] }>();
  for (const row of rows) {
    if (row.isHost || row.personId) continue;
    const key = nameKey(row.name);
    if (!key) continue;
    if (hostKeys.has(key)) {
      out.hostNamed += 1;
      continue;
    }
    const entry = byKey.get(key) ?? { name: row.name as string, ids: [] };
    entry.ids.push(row.id);
    byKey.set(key, entry);
  }
  for (const { name, ids } of byKey.values()) {
    const decision = decideCreate(await sameNamePeople(tx, ctx, name));
    let personId: string;
    if (decision.kind === "leave_unlinked") {
      out.leftUnlinked += ids.length;
      continue;
    } else if (decision.kind === "reuse") {
      personId = decision.personId;
      out.reused += 1;
    } else {
      const [person] = await tx
        .insert(schema.people)
        .values({ accountId: ctx.accountId, email: null, name: normalizeName(name) })
        .returning({ id: schema.people.id });
      personId = person.id;
      out.created += 1;
    }
    await tx.update(schema.attendees).set({ personId }).where(inArray(schema.attendees.id, ids));
  }
  return out;
}

// After a correction: of the people the recording's previous rows pointed at,
// delete each that step 2 made (no address) and that nothing points at any
// more. Anything else is left. -> how many were deleted.
//
// The not-exists list is every foreign key to people.id, checked against
// schema.ts (and pg_constraint on main, 2026-10-31): attendees.person_id,
// speakers.person_id, invitees.person_id, clips.created_by, shares.created_by.
// moments has no column referencing people; per the 1d decision a moment whose
// metadata carries the id counts as a reference too. A new foreign key to
// people.id must be added here.
export async function dropReleasedPeople(tx: Tx, accountId: string, personIds: string[]): Promise<number> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return 0;
  const p = schema.people;
  const deleted = await tx
    .delete(p)
    .where(
      and(
        eq(p.accountId, accountId),
        inArray(p.id, ids),
        isNull(p.email),
        sql`not exists (select 1 from ${schema.attendees} where ${schema.attendees.personId} = ${p.id})`,
        sql`not exists (select 1 from ${schema.speakers} where ${schema.speakers.personId} = ${p.id})`,
        sql`not exists (select 1 from ${schema.invitees} where ${schema.invitees.personId} = ${p.id})`,
        sql`not exists (select 1 from ${schema.clips} where ${schema.clips.createdBy} = ${p.id})`,
        sql`not exists (select 1 from ${schema.shares} where ${schema.shares.createdBy} = ${p.id})`,
        sql`not exists (select 1 from ${schema.moments} where ${schema.moments.accountId} = ${accountId} and position(${p.id}::text in coalesce(${schema.moments.metadata}::text, '')) > 0)`,
      ),
    )
    .returning({ id: p.id });
  return deleted.length;
}

// The recording's voices and the people they are (SAA-260 step 3), for the
// recorder's voice-print store on the Mac: ids only, never a name.
//   voices  each Voice N speaker row with a person (the voice-names copy from
//           the attendee row, voice-names.ts), by its index
//   them    when the recording has no Voice N rows: the person of its one
//           guest attendee, when there is exactly one guest and that guest is
//           linked; otherwise null. Whether `them` is one voice is the Mac's
//           to judge from its diarize file (it refuses a merged `them`).
export type VoicePeople = { voices: Array<{ voiceIndex: number; personId: string }>; them: string | null };
const VOICE_INDEX = /^Voice (\d+)$/;
export async function voicePeopleFor(executor: typeof db | Tx, recordingId: string): Promise<VoicePeople> {
  const speakers = await executor
    .select({ label: schema.speakers.label, personId: schema.speakers.personId })
    .from(schema.speakers)
    .where(eq(schema.speakers.recordingId, recordingId));
  const voices: VoicePeople["voices"] = [];
  let anyVoiceRow = false;
  for (const s of speakers) {
    const m = VOICE_INDEX.exec(s.label ?? "");
    if (!m) continue;
    anyVoiceRow = true;
    if (s.personId) voices.push({ voiceIndex: Number(m[1]), personId: s.personId });
  }
  voices.sort((a, b) => a.voiceIndex - b.voiceIndex);
  let them: string | null = null;
  if (!anyVoiceRow && speakers.some((s) => s.label === "them")) {
    const guests = await executor
      .select({ name: schema.attendees.name, personId: schema.attendees.personId })
      .from(schema.attendees)
      .where(and(eq(schema.attendees.recordingId, recordingId), eq(schema.attendees.isHost, false)));
    const named = guests.filter((g) => nameKey(g.name) !== null);
    if (named.length === 1 && named[0].personId) them = named[0].personId;
  }
  return { voices, them };
}

// Counts only: a name never goes in a log.
export function describeLinking(l: AttendeeLinking, dropped = 0): string {
  return `created=${l.created} reused=${l.reused} left_unlinked=${l.leftUnlinked} host_named=${l.hostNamed}${dropped ? ` dropped=${dropped}` : ""}`;
}
