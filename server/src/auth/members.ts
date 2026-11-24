// Membership operations shared by the CLI (cli.ts) and the checks, so what the
// checks exercise is the code the CLI runs.

import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { deleteRecordings } from "../db/delete-recordings.js";
import { decrypt } from "../lib/crypto.js";
import { revokeToken, type RevokeResult } from "../lib/google-calendar.js";
import { getAuth } from "./auth.js";
import { normalizeEmail, type MemberRow } from "./membership.js";
import { DEMO_SOURCE, seedDemoForNewMember } from "../demo/seed.js";

// A refusal is a normal "no" with a message meant for the person running the
// command, as opposed to a bug. The code is for the route
// (routes/capture-members.ts); the message is for the person at the CLI.
export class Refusal extends Error {
  constructor(
    message: string,
    readonly code: string = "refused",
  ) {
    super(message);
  }
}

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

// Every new membership is saved here (add-member and bootstrap-admin), and its
// two demo calls are seeded right after (demo/seed.ts, SAA-198 step 6): after
// the row is saved, not inside its insert, so a seeding failure is logged and
// never stops a member being added.
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
  await seedDemoForNewMember({ id: row.id, accountId: row.accountId });
  return row;
}

export async function addMember(input: { email: string; role: Role; name?: string | null }): Promise<MemberRow> {
  const account = await requireAccount();
  const [existing] = await db
    .select()
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.accountId, account.id), eq(schema.accountMembers.email, input.email)));
  if (existing) {
    // Any future re-add path must, in one transaction, delete the member's
    // oauthRefreshToken, oauthAccessToken, oauthConsent and
    // refresh_token_recoveries rows and their auth sessions before clearing
    // removed_at. A refresh grant racing removeMember
    // can leave a refresh token behind: the grant revokes the old row and inserts
    // the new one in separate statements, and a DELETE that commits between them
    // misses the new row. The refresh grant does not check membership, so that
    // token would work again once removed_at is cleared. Clearing removed_at by
    // hand SQL is unsafe for the same reason.
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

// What a member's removal deletes (SAA-347): every call they own that is
// personal, in the trash, or one of their demo calls (demo/seed.ts, live or
// trashed). Their live work calls and live unlabelled calls (scope null) stay
// with the team. Written as the kinds it deletes, never as "not work": that
// would rest on how SQL treats a null scope.
export const departureFilter = (memberId: string): SQL =>
  and(
    eq(schema.recordings.ownerMemberId, memberId),
    or(eq(schema.recordings.scope, "personal"), isNotNull(schema.recordings.trashedAt), eq(schema.recordings.source, DEMO_SOURCE)),
  )!;

export type GoogleOutcome = RevokeResult["outcome"] | "not_attempted";
// Ids and counts only: never an email, an address, a name or a token.
export type RemovalReport = {
  memberId: string;
  deleted: { recordings: number; personal: number; trashed: number; demo: number; peopleReleased: number };
  kept: { work: number; unlabelled: number };
  revoked: { sessions: number; accessTokens: number; refreshTokens: number; consents: number; recoveries: number };
  calendar: {
    connectionsDeleted: number;
    google: Array<{ connectionId: string; outcome: GoogleOutcome; status?: number; error?: string | null }>;
  };
  adminNote: string | null;
};

// Added to a report when Google did not confirm, for some connection, that the
// grant is gone (anything but revoked or already_invalid).
export const GOOGLE_ACCESS_NOTE =
  "Google did not confirm that Clipwise's calendar access ended for every connection: ask the member to remove Clipwise at myaccount.google.com → Third-party apps.";

// A member's departure (SAA-347), in one transaction: the member row and every
// active admin row are locked (in id order, so two removals never wait on each
// other crosswise) and the refusals made under the lock, so two removals of the
// last two admins cannot both pass. Then: removed_at; their sessions, MCP and
// recorder tokens, consents and refresh_token_recoveries rows (ours, with no
// foreign key to Better Auth's tables, so nothing cascades to it); their calls
// by departureFilter, with everything under them (db/delete-recordings.ts);
// their calendar connections, whose refresh tokens are decrypted in memory. A
// token that cannot be decrypted is not_attempted, not a failed removal.
//
// After the commit, each grant is revoked at Google once (revokeToken), all at
// once, each within the Google deadline. Nothing in the transaction waits on
// Google, and Google's answer never undoes a removal; it is reported.
//
// Access is also refused per request by membership (authenticate.ts), so the
// deleted sign-ins are the second line, not the only one. auth_user and
// auth_account stay. Self-removal is refused by the route, not here: the CLI's
// operator is not a member.
export async function removeMember(email: string): Promise<{ member: MemberRow; revoked: boolean; report: RemovalReport }> {
  const account = await requireAccount();
  const m = schema.accountMembers;
  const r = schema.recordings;
  const done = await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(m)
      .where(and(eq(m.accountId, account.id), or(eq(m.email, email), and(eq(m.role, "admin"), isNull(m.removedAt)))))
      .orderBy(m.id)
      .for("update");
    const member = locked.find((x) => x.email === email);
    if (!member) throw new Refusal(`${email} is not a member`, "not_a_member");
    if (member.removedAt) throw new Refusal(`${email} is already removed`, "already_removed");
    if (member.role === "admin" && locked.filter((x) => x.role === "admin" && !x.removedAt).length <= 1) {
      throw new Refusal("that is the last admin; add another admin first", "last_admin");
    }
    const now = new Date();
    await tx.update(m).set({ removedAt: now, updatedAt: now }).where(eq(m.id, member.id));

    const revoked = { sessions: 0, accessTokens: 0, refreshTokens: 0, consents: 0, recoveries: 0 };
    if (member.authUserId) {
      const uid = member.authUserId;
      const n = async (q: SQL) => (await tx.execute(q)).rowCount ?? 0;
      revoked.sessions = await n(sql`delete from auth_session where "userId" = ${uid}`);
      revoked.accessTokens = await n(sql`delete from "oauthAccessToken" where "userId" = ${uid}`);
      revoked.refreshTokens = await n(sql`delete from "oauthRefreshToken" where "userId" = ${uid}`);
      revoked.consents = await n(sql`delete from "oauthConsent" where "userId" = ${uid}`);
      revoked.recoveries = await n(sql`delete from refresh_token_recoveries where user_id = ${uid}`);
    }

    // Each call's kind, read under a lock before the delete, for the counts. A
    // call that matched only by the delete's own read is counted in recordings
    // and in no kind.
    const filter = departureFilter(member.id);
    const kinds = await tx
      .select({ id: r.id, demo: sql<boolean>`coalesce(${r.source} = ${DEMO_SOURCE}, false)`, trashed: sql<boolean>`${r.trashedAt} is not null` })
      .from(r)
      .where(and(eq(r.accountId, account.id), filter))
      .for("update");
    const kindOf = new Map(kinds.map((k) => [k.id, k.demo ? "demo" : k.trashed ? "trashed" : "personal"] as const));
    const gone = await deleteRecordings(tx, account.id, filter);
    const deleted = { recordings: gone.recordingIds.length, personal: 0, trashed: 0, demo: 0, peopleReleased: gone.peopleReleased };
    for (const id of gone.recordingIds) {
      const k = kindOf.get(id);
      if (k) deleted[k]++;
    }
    const [kept] = await tx
      .select({
        work: sql<number>`(count(*) filter (where ${r.scope} = 'work'))::int`,
        unlabelled: sql<number>`(count(*) filter (where ${r.scope} is null))::int`,
      })
      .from(r)
      .where(and(eq(r.accountId, account.id), eq(r.ownerMemberId, member.id)));

    const c = schema.calendarConnections;
    const conns = await tx.delete(c).where(eq(c.memberId, member.id)).returning({ id: c.id, refreshToken: c.refreshToken });
    const toRevoke = conns.map((x) => {
      try {
        return { id: x.id, token: decrypt(x.refreshToken) as string | null };
      } catch {
        return { id: x.id, token: null };
      }
    });
    return { member: { ...member, removedAt: now }, revoked, deleted, kept, toRevoke };
  });

  const google = await Promise.all(
    done.toRevoke.map(async (x) =>
      x.token === null ? { connectionId: x.id, outcome: "not_attempted" as const } : { connectionId: x.id, ...(await revokeToken(x.token)) },
    ),
  );
  const confirmed = google.every((g) => g.outcome === "revoked" || g.outcome === "already_invalid");
  const report: RemovalReport = {
    memberId: done.member.id,
    deleted: done.deleted,
    kept: { work: done.kept?.work ?? 0, unlabelled: done.kept?.unlabelled ?? 0 },
    revoked: done.revoked,
    calendar: { connectionsDeleted: done.toRevoke.length, google },
    adminNote: confirmed ? null : GOOGLE_ACCESS_NOTE,
  };
  return { member: done.member, revoked: !!done.member.authUserId, report };
}

// The report as the CLI prints it: one line per part, ids and counts only.
export function formatRemovalReport(r: RemovalReport): string[] {
  const d = r.deleted;
  const v = r.revoked;
  return [
    `removed member=${r.memberId}`,
    `deleted: recordings=${d.recordings} (personal=${d.personal} trashed=${d.trashed} demo=${d.demo}) people_released=${d.peopleReleased}`,
    `kept: work=${r.kept.work} unlabelled=${r.kept.unlabelled}`,
    `revoked: sessions=${v.sessions} access_tokens=${v.accessTokens} refresh_tokens=${v.refreshTokens} consents=${v.consents} recoveries=${v.recoveries}`,
    `calendar: connections_deleted=${r.calendar.connectionsDeleted}`,
    ...r.calendar.google.map(
      (g) => `calendar ${g.connectionId}: ${g.outcome}${g.outcome === "refused" ? ` status=${g.status} error=${g.error ?? "none"}` : ""}`,
    ),
    ...(r.adminNote ? [r.adminNote] : []),
  ];
}
