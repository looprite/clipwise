// The one place that decides what a member may see. Every query that reads
// recording content builds its condition from these, so the rule has one
// definition and one test (check-access.ts).
//
// The rule:
//   - a recording is visible to its owner, whatever its visibility or scope;
//   - to anyone else in the account only if it is 'shared' AND not a
//     personal-scope call — a personal call (the family FaceTime case the
//     scope column was built for) is never shared, whatever visibility says;
//   - a recording with no owner is visible to no one (it is not lost; the
//     bootstrap CLI's --claim-existing gives it one);
//   - a personnel-assessment moment (candid commentary about a named
//     colleague, moments.is_personnel_assessment) is visible only to the
//     recording's owner, even inside a shared recording.
//
// Role does not appear here: an admin manages members and sees exactly what
// any other member would. Admin is not a way to read other people's private
// recordings.
//
// These return SQL for use in WHERE clauses. recordingVisibleTo and
// momentVisibleTo need the `recordings` table in the query (every moment query
// joins it already); personVisibleTo is for queries on `people`.

import { and, eq, exists, isNull, ne, not, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AccessContext } from "./context.js";

const r = schema.recordings;

export function recordingVisibleTo(ctx: AccessContext): SQL {
  return and(
    eq(r.accountId, ctx.accountId),
    or(
      eq(r.ownerMemberId, ctx.memberId),
      and(eq(r.visibility, "shared"), or(isNull(r.scope), ne(r.scope, "personal"))),
    ),
  )!;
}

// For writes: only the owner may add to or change a recording.
export function recordingOwnedBy(ctx: AccessContext): SQL {
  return and(eq(r.accountId, ctx.accountId), eq(r.ownerMemberId, ctx.memberId))!;
}

export function momentVisibleTo(ctx: AccessContext): SQL {
  return or(eq(schema.moments.isPersonnelAssessment, false), eq(r.ownerMemberId, ctx.memberId))!;
}

// A person row is shared address-book material: it carries a name and an
// email, and it exists because someone was on a call. It is visible when it is
// attached to a recording the member can see, or when it is attached to no
// recording at all (nothing to reveal). A person who appears only on someone
// else's private recording is not visible — their name would reveal that the
// recording exists.
export function personVisibleTo(ctx: AccessContext): SQL {
  const p = schema.people;
  const one = sql`1`;
  const viaAttendee = exists(
    db
      .select({ one })
      .from(schema.attendees)
      .innerJoin(r, eq(r.id, schema.attendees.recordingId))
      .where(and(eq(schema.attendees.personId, p.id), recordingVisibleTo(ctx))),
  );
  const viaSpeaker = exists(
    db
      .select({ one })
      .from(schema.speakers)
      .innerJoin(r, eq(r.id, schema.speakers.recordingId))
      .where(and(eq(schema.speakers.personId, p.id), recordingVisibleTo(ctx))),
  );
  const viaInvitee = exists(
    db
      .select({ one })
      .from(schema.invitees)
      .innerJoin(r, eq(r.id, schema.invitees.recordingId))
      .where(and(eq(schema.invitees.personId, p.id), recordingVisibleTo(ctx))),
  );
  const anyAttendee = exists(db.select({ one }).from(schema.attendees).where(eq(schema.attendees.personId, p.id)));
  const anySpeaker = exists(db.select({ one }).from(schema.speakers).where(eq(schema.speakers.personId, p.id)));
  const anyInvitee = exists(db.select({ one }).from(schema.invitees).where(eq(schema.invitees.personId, p.id)));
  return and(
    eq(p.accountId, ctx.accountId),
    or(viaAttendee, viaSpeaker, viaInvitee, and(not(anyAttendee), not(anySpeaker), not(anyInvitee))),
  )!;
}
