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

import { Router, type Request, type RequestHandler } from "express";
import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { normalizeEmail } from "../auth/membership.js";
import { db, schema } from "../db/index.js";
import { deleteRecordings } from "../db/delete-recordings.js";
import { CLIPWISE_SOURCE, titlePlaceholderFor } from "../ingest/clipwise.js";
import { ownerAddressesFor } from "../ingest/invitee-names.js";
import { shownTitle } from "../ingest/title.js";
import { logAccess, searchAccessLine } from "../lib/access-line.js";
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
    logAccess(accessOf(req).memberId, "capture.transcript", id);
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

// Rename (SAA-135): the owner only (ownCapture: anyone else's is 404, as for
// trash), not a trashed capture. The title is trimmed and must be 1 to 200
// characters with no control character. Stored like any title (encrypted), with
// title_source member, which no calendar match or fallback replaces
// (ingest/title.ts). The log line is ids and a length; the title is never logged.
const titleSchema = z.object({ title: z.string() }).strict();
const TITLE_MAX = 200;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

captureScopeRouter.post(
  "/captures/:captureId/title",
  asyncHandler(async (req, res) => {
    const { id, trashedAt } = await ownCapture(req);
    if (trashedAt) throw new HttpError(404, "capture_not_found");
    const body = parseBody(titleSchema, req);
    const title = body.title.trim();
    if (title === "" || title.length > TITLE_MAX || CONTROL_CHARACTER.test(body.title)) throw new HttpError(400, "title_invalid");
    await db.update(schema.recordings).set({ title, titleSource: "member", updatedAt: new Date() }).where(eq(schema.recordings.id, id));
    console.log(`title: member=${accessOf(req).memberId} recording=${id} renamed chars=${title.length}`);
    res.json({ title });
  }),
);

// The caller's own capture titles since a time (SAA-135), for Recent meetings:
// one reply instead of a jobs request per row, so a title set after the Mac
// stopped asking (a backfill, a rename from another Mac) still reaches it.
// since defaults to 8 days ago and is held to the last 31; trashed captures are
// left out; at most 500, newest first. Each is { captureId, title }, title null
// while it is the placeholder (ingest/title.ts shownTitle). Titles are call
// text, so the read writes one access line (ids only). Mounted in app.ts with
// requireCapture, ahead of /captures/:captureId.
const titlesQuery = z.object({ since: z.string().datetime({ offset: true }).optional() });
const TITLES_DEFAULT_DAYS = 8;
const TITLES_MAX_DAYS = 31;
const TITLES_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export const captureTitlesGet: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const q = parseQuery(titlesQuery, req);
  const floor = Date.now() - TITLES_MAX_DAYS * DAY_MS;
  const since = new Date(Math.max(floor, q.since ? Date.parse(q.since) : Date.now() - TITLES_DEFAULT_DAYS * DAY_MS));
  const rows = await db
    .select({ id: schema.recordings.id, captureId: schema.recordings.sourceId, title: schema.recordings.title, titleSource: schema.recordings.titleSource })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.accountId, ctx.accountId),
        eq(schema.recordings.source, CLIPWISE_SOURCE),
        eq(schema.recordings.ownerMemberId, ctx.memberId),
        isNull(schema.recordings.trashedAt),
        gte(schema.recordings.startedAt, since),
      ),
    )
    .orderBy(desc(schema.recordings.startedAt))
    .limit(TITLES_LIMIT);
  console.log(searchAccessLine(ctx.memberId, "capture.titles", rows.map((r) => r.id)));
  res.json({ since: since.toISOString(), titles: rows.map((r) => ({ captureId: r.captureId, title: shownTitle(r.title, r.titleSource) })) });
});

captureScopeRouter.post(
  "/captures/:captureId/restore",
  asyncHandler(async (req, res) => {
    const { id } = await ownCapture(req);
    await db.update(schema.recordings).set({ trashedAt: null }).where(eq(schema.recordings.id, id));
    res.json({ trashed: false });
  }),
);

// Only from the trash: the row goes only while it is still trashed, so a restore
// that lands first wins. The delete itself, with everything that references the
// recording and the people it releases, is db/delete-recordings.ts's, the one
// deletion the host's delete-member-calls uses too (SAA-289; check-access 18f
// and 18g).
captureScopeRouter.delete(
  "/captures/:captureId",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const { id, trashedAt } = await ownCapture(req);
    if (!trashedAt) throw new HttpError(409, "capture_not_trashed");
    const deleted = await db.transaction(async (tx) => {
      const { recordingIds } = await deleteRecordings(
        tx,
        ctx.accountId,
        and(eq(schema.recordings.id, id), isNotNull(schema.recordings.trashedAt))!,
      );
      return recordingIds.length > 0;
    });
    if (!deleted) throw new HttpError(409, "capture_not_trashed");
    res.json({ deleted: true });
  }),
);

// The capture's jobs, oldest first, for the tray. Kind, state and attempts only:
// no error text.
//
// And its calendar match, once a match job is done and found one (SAA-227
// decisions 15 and 29), for Recent Meetings: the event's title, if it replaced
// the placeholder, and each invitee by name, or by address when Google has no
// name. Every address of the owner's is left out (who else was on the call), by
// the rule ingest uses (invitee-names.ts ownerAddressesFor): the sign-in address,
// the calendar connection's address, and each searched calendar whose id is an
// address (SAA-260 11-07: a calendar shared into the grant showed the owner's
// work address as a guest). Only the owner's own capture is served, and those
// addresses were on the owner's invite.
// null until then, and when the match found nothing.
async function calendarOf(recordingId: string, owner: Set<string>): Promise<{ title: string | null; invitees: { name: string }[] } | null> {
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
    .filter((r) => !owner.has(normalizeEmail(r.email)))
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
    const ctx = accessOf(req);
    // The title as it stands, match or not (SAA-135): a fallback, a rename, or
    // the event's; null while it is the placeholder. `calendar` is as before.
    const [rec] = await db
      .select({ title: schema.recordings.title, titleSource: schema.recordings.titleSource })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, id));
    res.json({
      jobs,
      title: rec ? shownTitle(rec.title, rec.titleSource) : null,
      calendar: matched ? await calendarOf(id, await ownerAddressesFor(db, ctx.memberId, ctx.email)) : null,
    });
  }),
);
