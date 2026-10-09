import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import type { AccessContext } from "../access/context.js";
import { recordingOwnedBy, recordingVisibleTo } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody, uuidParam } from "../lib/http.js";
import { slugify, slugWithSuffix } from "../lib/slug.js";

const createRecordingSchema = z.object({
  title: z.string().max(512).optional(),
  slug: z.string().max(128).optional(),
  source: z.string().max(64).optional(),
  sourceId: z.string().max(256).optional(),
  mediaUrl: z.string().url().max(2048).optional(),
  durationSec: z.number().nonnegative().optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  status: z.string().max(32).optional(),
  meetingKind: z.string().max(32).optional(),
  // Private unless the owner says otherwise.
  visibility: z.enum(["private", "shared"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createAttendeeSchema = z.object({
  email: z.string().email().max(320).optional(),
  name: z.string().max(256).optional(),
  role: z.string().max(64).optional(),
  domainKind: z.enum(["internal", "external"]).optional(),
  isHost: z.boolean().optional(),
  personId: z.string().uuid().optional(),
});

export const recordingsRouter = Router({ mergeParams: true });
recordingsRouter.param("id", uuidParam("recording_not_found"));

// "Not found" covers a recording that is trashed (SAA-154), that does not
// exist, and that the caller may not see — the same answer for all three.
async function findRecording(ctx: AccessContext, recordingId: string) {
  const [recording] = await db
    .select()
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.id, recordingId),
        isNull(schema.recordings.trashedAt),
        recordingVisibleTo(ctx),
      ),
    );
  return recording;
}

async function findOwnedRecording(ctx: AccessContext, recordingId: string) {
  const [recording] = await db
    .select()
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.id, recordingId),
        isNull(schema.recordings.trashedAt),
        recordingOwnedBy(ctx),
      ),
    );
  return recording;
}

recordingsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const body = parseBody(createRecordingSchema, req);
    const slug = body.slug
      ? slugify(body.slug)
      : slugWithSuffix(body.title ?? "recording");
    const [recording] = await db
      .insert(schema.recordings)
      .values({
        accountId: ctx.accountId,
        ownerMemberId: ctx.memberId,
        visibility: body.visibility ?? "private",
        slug,
        title: body.title,
        source: body.source,
        sourceId: body.sourceId,
        mediaUrl: body.mediaUrl,
        durationSec: body.durationSec,
        startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
        endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
        status: body.status ?? "pending",
        meetingKind: body.meetingKind,
        metadata: body.metadata,
      })
      .returning();
    res.status(201).json({ recording });
  }),
);

recordingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const recordings = await db
      .select()
      .from(schema.recordings)
      .where(and(recordingVisibleTo(ctx), isNull(schema.recordings.trashedAt)))
      .orderBy(desc(schema.recordings.startedAt));
    res.json({ recordings });
  }),
);

recordingsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const recording = await findRecording(accessOf(req), req.params.id);
    if (!recording) throw new HttpError(404, "recording_not_found");
    const attendees = await db
      .select()
      .from(schema.attendees)
      .where(eq(schema.attendees.recordingId, recording.id));
    res.json({ recording, attendees });
  }),
);

recordingsRouter.post(
  "/:id/attendees",
  asyncHandler(async (req, res) => {
    const recording = await findOwnedRecording(accessOf(req), req.params.id);
    if (!recording) throw new HttpError(404, "recording_not_found");
    const body = parseBody(createAttendeeSchema, req);
    const [attendee] = await db
      .insert(schema.attendees)
      .values({
        recordingId: recording.id,
        personId: body.personId,
        email: body.email,
        name: body.name,
        role: body.role,
        domainKind: body.domainKind,
        isHost: body.isHost ?? false,
      })
      .returning();
    res.status(201).json({ attendee });
  }),
);

recordingsRouter.get(
  "/:id/attendees",
  asyncHandler(async (req, res) => {
    const recording = await findRecording(accessOf(req), req.params.id);
    if (!recording) throw new HttpError(404, "recording_not_found");
    const attendees = await db
      .select()
      .from(schema.attendees)
      .where(eq(schema.attendees.recordingId, recording.id));
    res.json({ attendees });
  }),
);
