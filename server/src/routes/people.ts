import { Router } from "express";
import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { personVisibleTo } from "../access/visibility.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseQuery } from "../lib/http.js";

const listPeopleQuerySchema = z.object({
  email: z.string().max(320).optional(),
});

export const peopleRouter = Router({ mergeParams: true });

// Read-only. There used to be a POST here that upserted by email; nothing
// called it (people rows are written by the capture pipeline), and an upsert
// by email would let a caller overwrite — and so detect — a person who only
// appears on someone else's private recording.

peopleRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const query = parseQuery(listPeopleQuerySchema, req);
    const where = query.email
      ? and(personVisibleTo(ctx), ilike(schema.people.email, `%${query.email}%`))
      : personVisibleTo(ctx);
    const people = await db.select().from(schema.people).where(where);
    res.json({ people });
  }),
);

peopleRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const [person] = await db
      .select()
      .from(schema.people)
      .where(and(personVisibleTo(ctx), eq(schema.people.id, req.params.id)));
    if (!person) throw new HttpError(404, "person_not_found");
    res.json({ person });
  }),
);
