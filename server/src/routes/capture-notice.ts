// POST /captures/notice (Gate 1, the member notice): the recorder reports the
// member's acknowledgement of the recording notice as soon as it is given (or at
// sign-in, when it was given before), so the server has it on record before any
// capture carries it. Each capture's notice stamp (routes/captures.ts) stays the
// fallback for an answer given offline or signed out; both write the same row.
//
// A capture token; the member comes from it, never from the body. Strict: the
// version and when the Mac recorded it, nothing else. One row per member per
// version (notice_acknowledgements' unique index), so a repeat writes nothing and
// the first acknowledged_at stands. Answers { recorded, version }: recorded false
// when that version was already on record.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { RequestHandler } from "express";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import { displayNameFor } from "./capture-people.js";

const noticeSchema = z
  .object({ version: z.number().int().min(1), acknowledgedAt: z.string().datetime({ offset: true }) })
  .strict();

export const captureNoticePost: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const body = parseBody(noticeSchema, req);
  const inserted = await db
    .insert(schema.noticeAcknowledgements)
    .values({ memberId: ctx.memberId, noticeVersion: body.version, acknowledgedAt: new Date(body.acknowledgedAt) })
    .onConflictDoNothing({ target: [schema.noticeAcknowledgements.memberId, schema.noticeAcknowledgements.noticeVersion] })
    .returning({ id: schema.noticeAcknowledgements.id });
  const recorded = inserted.length > 0;
  console.log(`notice: member=${ctx.memberId} v${body.version} ${recorded ? "recorded" : "already on record"}`);
  res.status(200).json({ recorded, version: body.version });
});

// GET /captures/members/notice (Gate 1, item 2): who accepted the recording
// notice, for an admin's "Team: who accepted the notice…" on the Mac. Mounted
// behind requireCapture and requireAdmin (app.ts): a member is 403 admin_only.
// The caller's own account only, and its members who have not been removed, in
// the order they were added. Per member: name (as GET /captures/me gives a name:
// trimmed, null when empty or an address), email, role, and the highest notice
// version on record with when the Mac recorded it, both null when none. Nothing
// else: not when they joined, not their recordings.
export const captureMembersNoticeGet: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const m = schema.accountMembers;
  const members = await db
    .select({ id: m.id, email: m.email, displayName: m.displayName, role: m.role })
    .from(m)
    .where(and(eq(m.accountId, ctx.accountId), isNull(m.removedAt)))
    .orderBy(asc(m.createdAt), asc(m.email));
  const n = schema.noticeAcknowledgements;
  const acks =
    members.length === 0
      ? []
      : await db
          .select({ memberId: n.memberId, version: n.noticeVersion, acknowledgedAt: n.acknowledgedAt })
          .from(n)
          .where(inArray(n.memberId, members.map((x) => x.id)));
  const latest = new Map<string, { version: number; acknowledgedAt: Date }>();
  for (const a of acks) {
    const had = latest.get(a.memberId);
    if (!had || a.version > had.version) latest.set(a.memberId, { version: a.version, acknowledgedAt: a.acknowledgedAt });
  }
  console.log(`team notice: member=${ctx.memberId} listed ${members.length} member(s)`);
  res.json({
    members: members.map((x) => {
      const l = latest.get(x.id);
      return {
        name: displayNameFor(x.displayName),
        email: x.email,
        role: x.role === "admin" ? "admin" : "member",
        latestVersion: l ? l.version : null,
        acceptedAt: l ? l.acknowledgedAt.toISOString() : null,
      };
    }),
  });
});
