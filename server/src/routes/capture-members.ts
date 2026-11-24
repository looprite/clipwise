// POST /captures/members and POST /captures/members/remove (SAA-347): an admin
// adds or removes a member of their own account, from the Mac. Mounted behind
// requireCapture and requireAdmin (app.ts), as GET /captures/members/notice is:
// a member is 403 admin_only, an MCP token 403 insufficient_scope.
//
// Both name the member by email, as the CLI and the notice listing do, and run
// the CLI's own code (auth/members.ts). Adding is addMember, unchanged, so a new
// member gets their demo calls; an admin may add an admin. Removing is
// removeMember: the whole departure in one transaction, then Google. An admin
// cannot remove themselves here (409 cannot_remove_self); nobody can remove the
// last admin (409 last_admin).
//
// A removal's reply is its report: ids and counts, never an email, an address or
// a token. Log lines carry ids only.

import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { addMember, Refusal, removeMember, requireAccount, requireEmail } from "../auth/members.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { displayNameFor } from "./capture-people.js";

const addSchema = z
  .object({ email: z.string().max(320), role: z.enum(["member", "admin"]).optional(), name: z.string().trim().max(200).optional() })
  .strict();
const removeSchema = z.object({ email: z.string().max(320) }).strict();

function emailOf(value: string): string {
  try {
    return requireEmail(value);
  } catch (err) {
    if (err instanceof Refusal) throw new HttpError(400, "invalid_email");
    throw err;
  }
}

// members.ts works on the instance's one account; it must be the caller's.
async function ownAccount(accountId: string): Promise<void> {
  if ((await requireAccount()).id !== accountId) throw new HttpError(404, "account_not_found");
}

async function memberByEmail(accountId: string, email: string) {
  const m = schema.accountMembers;
  const [row] = await db.select({ id: m.id, removedAt: m.removedAt }).from(m).where(and(eq(m.accountId, accountId), eq(m.email, email)));
  return row ?? null;
}

export const captureMembersPost: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const body = parseBody(addSchema, req);
  const email = emailOf(body.email);
  await ownAccount(ctx.accountId);
  try {
    const row = await addMember({ email, role: body.role ?? "member", name: body.name ? body.name : null });
    console.log(`members: member=${ctx.memberId} added member=${row.id} role=${row.role}`);
    res.status(201).json({ added: { email: row.email, role: row.role === "admin" ? "admin" : "member", name: displayNameFor(row.displayName) } });
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    throw new HttpError(409, (await memberByEmail(ctx.accountId, email))?.removedAt ? "member_removed" : "already_member");
  }
});

export const captureMembersRemovePost: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const email = emailOf(parseBody(removeSchema, req).email);
  await ownAccount(ctx.accountId);
  if ((await memberByEmail(ctx.accountId, email))?.id === ctx.memberId) throw new HttpError(409, "cannot_remove_self");
  let report;
  try {
    ({ report } = await removeMember(email));
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    throw new HttpError(err.code === "not_a_member" ? 404 : 409, err.code);
  }
  console.log(
    `members: member=${ctx.memberId} removed member=${report.memberId} deleted=${report.deleted.recordings} kept=${report.kept.work + report.kept.unlabelled} calendar=${report.calendar.connectionsDeleted} google=${report.calendar.google.map((g) => g.outcome).join(",") || "none"}`,
  );
  res.json({ removed: report });
});
