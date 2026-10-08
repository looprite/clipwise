import { Router } from "express";
import { eq } from "drizzle-orm";
import { accessOf } from "../access/authenticate.js";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError } from "../lib/http.js";

export const accountsRouter = Router();

// Who am I, and in which account. This replaces the three routes that used to
// live here: POST / (creating a second account would make ingest's
// exactly-one-account guard throw and stop every capture), GET / (every
// account) and GET /:id. An instance has one account, made by the provisioning
// CLI (src/auth/cli.ts init-account).
accountsRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const [account] = await db
      .select({ id: schema.accounts.id, name: schema.accounts.name, slug: schema.accounts.slug })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, ctx.accountId));
    if (!account) throw new HttpError(404, "account_not_found");
    const [member] = await db
      .select({
        id: schema.accountMembers.id,
        email: schema.accountMembers.email,
        displayName: schema.accountMembers.displayName,
        role: schema.accountMembers.role,
      })
      .from(schema.accountMembers)
      .where(eq(schema.accountMembers.id, ctx.memberId));
    res.json({ account, member });
  }),
);
