// What the recorder may do with its owner's own captures, with the one token it
// holds (SAA-227, 10-11 "Changed from 10-09"): read the transcript, trash,
// restore, delete permanently, and see the capture's jobs and calendar match. Each takes a capture
// token (app.ts mounts requireCapture on /captures/:captureId). The capture is
// named by its captureId, as POST /captures names it, and must be the caller's
// own: anyone else's, a malformed id and one that is not there all get the same
// 404 capture_not_found.
//
// Trash state is recordings.trashed_at, and these routes own it (SAA-227 part L
// decision 8): the Mac's trashed-<stem>.json marker and its files follow what
// they answer (recorder/app/main.js runTrashOnServer). The files on the Mac are
// the recorder's business.

import { Router, type Request } from "express";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { normalizeEmail } from "../auth/membership.js";
import { db, schema } from "../db/index.js";
import { CLIPWISE_SOURCE, titlePlaceholderFor } from "../ingest/clipwise.js";
import { asyncHandler, HttpError, parseBody, parseQuery, uuidParam } from "../lib/http.js";
import { buildTranscriptFile } from "../lib/transcript-read.js";

export const captureScopeRouter = Router();
captureScopeRouter.param("captureId", uuidParam("capture_not_found"));

async function ownCapture(req: Request): Promise<{ id: string; trashedAt: Date | null }> {
  const ctx = accessOf(req);
  const [row] = await db
    .select({ id: schema.recordings.id, trashedAt: schema.recordings.trashedAt })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.accountId, ctx.accountId),
        eq(schema.recordings.source, CLIPWISE_SOURCE),
        eq(schema.recordings.sourceId, req.params.captureId),
        eq(schema.recordings.ownerMemberId, ctx.memberId),
      ),
    );
  if (!row) throw new HttpError(404, "capture_not_found");
  return row;
}

// The saved transcript file, built by the same function as the Mac's
// save-transcript.ts. A trashed capture is not found. ?tz= is the recorder's IANA
// time zone, which the date and the file name are written in, so the file is the
// one the Mac would make; a zone Intl does not know is 400.
const transcriptQuery = z.object({ tz: z.string().max(64).optional() });

captureScopeRouter.get(
  "/captures/:captureId/transcript",
  asyncHandler(async (req, res) => {
    const { tz } = parseQuery(transcriptQuery, req);
    if (tz !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new HttpError(400, "invalid_time_zone");
      }
    }
    const { id } = await ownCapture(req);
    const file = await buildTranscriptFile(id, tz);
    if (!file) throw new HttpError(404, "capture_not_found");
    if (file.lines === 0) throw new HttpError(422, "transcript_empty");
    res.json(file);
  }),
);

// The trash time the recorder's marker holds, so the two agree; now if none.
const trashSchema = z.object({ trashedAt: z.string().datetime({ offset: true }).optional() });

captureScopeRouter.post(
  "/captures/:captureId/trash",
  asyncHandler(async (req, res) => {
    const body = parseBody(trashSchema, req);
    const { id } = await ownCapture(req);
    const at = body.trashedAt ? new Date(body.trashedAt) : new Date();
    await db.update(schema.recordings).set({ trashedAt: at }).where(eq(schema.recordings.id, id));
    res.json({ trashed: true, trashedAt: at.toISOString() });
  }),
);

captureScopeRouter.post(
  "/captures/:captureId/restore",
  asyncHandler(async (req, res) => {
    const { id } = await ownCapture(req);
    await db.update(schema.recordings).set({ trashedAt: null }).where(eq(schema.recordings.id, id));
    res.json({ trashed: false });
  }),
);

// Only from the trash: the row goes only while it is still trashed, so a restore
// that lands first wins. Every row that references it goes with it, by the
// foreign keys' ON DELETE CASCADE (check-access 18f finds them all).
captureScopeRouter.delete(
  "/captures/:captureId",
  asyncHandler(async (req, res) => {
    const { id, trashedAt } = await ownCapture(req);
    if (!trashedAt) throw new HttpError(409, "capture_not_trashed");
    const gone = await db
      .delete(schema.recordings)
      .where(and(eq(schema.recordings.id, id), isNotNull(schema.recordings.trashedAt)))
      .returning({ id: schema.recordings.id });
    if (gone.length === 0) throw new HttpError(409, "capture_not_trashed");
    res.json({ deleted: true });
  }),
);

// The capture's jobs, oldest first, for the tray. Kind, state and attempts only:
// no error text.
//
// And its calendar match, once a match job is done and found one (SAA-227
// decisions 15 and 29), for Recent Meetings: the event's title, if it replaced
// the placeholder, and each invitee by name, or by address when Google has no
// name. The owner's own address is left out (who else was on the call). Only the
// owner's own capture is served, and those addresses were on the owner's invite.
// null until then, and when the match found nothing.
async function calendarOf(recordingId: string, ownerEmail: string): Promise<{ title: string | null; invitees: { name: string }[] } | null> {
  const [rec] = await db
    .select({ title: schema.recordings.title, stem: sql<string | null>`${schema.recordings.metadata}->'capture'->>'stem'` })
    .from(schema.recordings)
    .where(eq(schema.recordings.id, recordingId));
  if (!rec) return null;
  const rows = await db
    .select({ email: schema.invitees.email, name: schema.invitees.name })
    .from(schema.invitees)
    .where(eq(schema.invitees.recordingId, recordingId))
    .orderBy(asc(schema.invitees.email));
  const invitees = rows
    .filter((r) => normalizeEmail(r.email) !== ownerEmail)
    .map((r) => ({ name: r.name?.trim() || r.email }));
  const title = rec.title && rec.title !== titlePlaceholderFor(rec.stem ?? "") ? rec.title : null;
  return title || invitees.length > 0 ? { title, invitees } : null;
}

captureScopeRouter.get(
  "/captures/:captureId/jobs",
  asyncHandler(async (req, res) => {
    const { id } = await ownCapture(req);
    const jobs = await db
      .select({ kind: schema.jobs.kind, state: schema.jobs.state, attempts: schema.jobs.attempts })
      .from(schema.jobs)
      .where(eq(schema.jobs.recordingId, id))
      .orderBy(asc(schema.jobs.createdAt));
    const matched = jobs.some((j) => j.kind === "match" && j.state === "done");
    res.json({ jobs, calendar: matched ? await calendarOf(id, accessOf(req).email) : null });
  }),
);
