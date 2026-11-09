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

import type { RequestHandler } from "express";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, parseBody } from "../lib/http.js";

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
