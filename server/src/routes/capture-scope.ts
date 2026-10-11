// What the recorder may do with its owner's own captures, with the one token it
// holds (SAA-227, 10-11 "Changed from 10-09"): read the transcript, trash,
// restore, delete permanently, and see the capture's jobs. Each takes a capture
// token (app.ts mounts requireCapture on /captures/:captureId). The capture is
// named by its captureId, as POST /captures names it, and must be the caller's
// own: anyone else's, a malformed id and one that is not there all get the same
// 404 capture_not_found.
//
// Trash state on the server is recordings.trashed_at, as pipeline/trash.ts
// writes it. The files on the Mac are the recorder's business.

import { Router, type Request } from "express";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { db, schema } from "../db/index.js";
import { CLIPWISE_SOURCE } from "../ingest/clipwise.js";
import { asyncHandler, HttpError, parseBody, uuidParam } from "../lib/http.js";
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
// save-transcript.ts. A trashed capture is not found.
captureScopeRouter.get(
  "/captures/:captureId/transcript",
  asyncHandler(async (req, res) => {
    const { id } = await ownCapture(req);
    const file = await buildTranscriptFile(id);
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

// Only from the trash, as pipeline/trash.ts: the row goes only while it is still
// trashed, so a restore that lands first wins. Its moments, segments, speakers
// and jobs go with it.
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
captureScopeRouter.get(
  "/captures/:captureId/jobs",
  asyncHandler(async (req, res) => {
    const { id } = await ownCapture(req);
    const jobs = await db
      .select({ kind: schema.jobs.kind, state: schema.jobs.state, attempts: schema.jobs.attempts })
      .from(schema.jobs)
      .where(eq(schema.jobs.recordingId, id))
      .orderBy(asc(schema.jobs.createdAt));
    res.json({ jobs });
  }),
);
