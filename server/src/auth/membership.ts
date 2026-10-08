// Who may sign in, and how a sign-in becomes a member.
//
// Sign-in (Better Auth) proves who someone is; this decides whether that
// person belongs to the instance. The two are kept apart on purpose:
// account_members is the allow-list, and nothing creates a login for an email
// that is not on it. There is no public sign-up — an admin adds the email
// first (src/auth/cli.ts), and the person's first verified sign-in links the
// login to that row.
//
// decideSignIn is pure so the rules can be checked without a database
// (check-membership.ts). The functions below it are the thin database side.

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export type MemberRow = typeof schema.accountMembers.$inferSelect;

export type SignInDenial =
  | "domain_not_allowed"
  | "not_a_member"
  | "member_removed"
  | "email_not_verified";

export type SignInDecision =
  | { allowed: true; member: MemberRow }
  | { allowed: false; reason: SignInDenial };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}

// Order matters only for which reason is reported; every denial is a denial.
// The domain check runs first and does not depend on the database, so a
// stranger's email is refused without revealing whether it is on the list.
export function decideSignIn(input: {
  email: string;
  emailVerified: boolean;
  // Null means no domain restriction beyond the member list.
  allowedDomain: string | null;
  member: MemberRow | null;
}): SignInDecision {
  const email = normalizeEmail(input.email);
  if (input.allowedDomain && domainOf(email) !== input.allowedDomain.trim().toLowerCase()) {
    return { allowed: false, reason: "domain_not_allowed" };
  }
  if (!input.member) return { allowed: false, reason: "not_a_member" };
  if (input.member.removedAt) return { allowed: false, reason: "member_removed" };
  if (!input.emailVerified) return { allowed: false, reason: "email_not_verified" };
  return { allowed: true, member: input.member };
}

export async function findMemberByEmail(email: string): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.email, normalizeEmail(email)));
  return row ?? null;
}

export async function findMemberByAuthUserId(authUserId: string): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.authUserId, authUserId));
  return row ?? null;
}

// First sign-in: attach the login to the member row. joined_at and
// display_name are only ever filled, never overwritten.
export async function linkMemberToUser(
  memberId: string,
  user: { authUserId: string; displayName?: string | null },
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.id, memberId));
  if (!row) return;
  await db
    .update(schema.accountMembers)
    .set({
      authUserId: user.authUserId,
      joinedAt: row.joinedAt ?? new Date(),
      displayName: row.displayName ?? (user.displayName?.trim() || null),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.accountMembers.id, memberId)));
}
