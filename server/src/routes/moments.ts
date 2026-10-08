import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { recordingOwnedBy } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody, parseQuery } from "../lib/http.js";
import { getMoment, searchMoments, searchMomentsQuerySchema } from "../services/search-moments.js";

const createMomentSchema = z.object({
  recordingId: z.string().uuid(),
  kind: z.string().min(1).max(64),
  title: z.string().max(512).optional(),
  summary: z.string().optional(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  score: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const momentsRouter = Router({ mergeParams: true });

// Hand-curated moments are added by the recording's owner. Anyone else gets
// the same 404 as for a recording that does not exist.
momentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const body = parseBody(createMomentSchema, req);
    const [recording] = await db
      .select({ id: schema.recordings.id })
      .from(schema.recordings)
      .where(and(recordingOwnedBy(ctx), eq(schema.recordings.id, body.recordingId)));
    if (!recording) throw new HttpError(404, "recording_not_found");

    const [moment] = await db
      .insert(schema.moments)
      .values({
        accountId: ctx.accountId,
        recordingId: body.recordingId,
        kind: body.kind,
        title: body.title,
        summary: body.summary,
        startSec: body.startSec,
        endSec: body.endSec,
        score: body.score,
        metadata: body.metadata,
      })
      .returning();
    res.status(201).json({ moment });
  }),
);

momentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const query = parseQuery(searchMomentsQuerySchema, req);
    res.json(await searchMoments(ctx, query));
  }),
);

momentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getMoment(accessOf(req), req.params.id));
  }),
);
