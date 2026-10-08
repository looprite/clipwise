// Membership operations shared by the CLI (cli.ts) and the checks, so what the
// checks exercise is the code the CLI runs.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { getAuth } from "./auth.js";
import { normalizeEmail, type MemberRow } from "./membership.js";

// A refusal is a normal "no" with a message meant for the person running the
// command, as opposed to a bug.
export class Refusal extends Error {}

export type Role = "admin" | "member";

export async function requireAccount() {
  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    throw new Refusal(
      accounts.length === 0
        ? "no account yet — run init-account first"
        : `expected exactly one account; found ${accounts.length}`,
    );
  }
  return accounts[0];
}

export function requireEmail(value: string | undefined): string {
  const email = normalizeEmail(value ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Refusal("--email is required and must be an email address");
  }
  return email;
}

export async function insertMember(
  accountId: string,
  email: string,
  role: Role,
  name: string | null,
): Promise<MemberRow> {
  const [row] = await db
    .insert(schema.accountMembers)
    .values({ accountId, email, role, displayName: name })
    .returning();
  return row;
}

export async function addMember(input: { email: string; role: Role; name?: string | null }): Promise<MemberRow> {
  const account = await requireAccount();
  const [existing] = await db
    .select()
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.accountId, account.id), eq(schema.accountMembers.email, input.email)));
  if (existing) {
    throw new Refusal(
      existing.removedAt ? `${input.email} was removed; re-adding is not supported yet` : `${input.email} is already a member`,
    );
  }
  return insertMember(account.id, input.email, input.role, input.name ?? null);
}

// The member row must exist before the login: the user-create hook refuses an
// email that is not an active member.
export async function createPasswordLogin(email: string, name: string, password: string): Promise<void> {
  const ctx = await getAuth().$context;
  const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(password),
  });
}

// Marks the member removed and cuts their live sign-ins. Access is also
// refused per request by membership (from the access-function commit on), so
// revoking sessions here is the second line, not the only one.
export async function removeMember(email: string): Promise<{ member: MemberRow; revoked: boolean }> {
  const account = await requireAccount();
  const [member] = await db
    .select()
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.accountId, account.id), eq(schema.accountMembers.email, email)));
  if (!member) throw new Refusal(`${email} is not a member`);
  if (member.removedAt) throw new Refusal(`${email} is already removed`);
  if (member.role === "admin") {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.accountMembers)
      .where(
        and(
          eq(schema.accountMembers.accountId, account.id),
          eq(schema.accountMembers.role, "admin"),
          isNull(schema.accountMembers.removedAt),
        ),
      );
    if (n <= 1) throw new Refusal("that is the last admin; add another admin first");
  }

  await db
    .update(schema.accountMembers)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.accountMembers.id, member.id));

  let revoked = false;
  if (member.authUserId) {
    const ctx = await getAuth().$context;
    await ctx.internalAdapter.deleteUserSessions(member.authUserId);
    for (const table of ["oauthRefreshToken", "oauthAccessToken", "oauthConsent"]) {
      await pool.query(`DELETE FROM "${table}" WHERE "userId" = $1`, [member.authUserId]);
    }
    revoked = true;
  }
  return { member: { ...member, removedAt: new Date() }, revoked };
}
