// One Google screen for sign-in and calendar (SAA-198 step 5, Jon's call 5;
// SAA-227's 10-13 correction to K decision 5). Google sign-in asks for
// calendar.readonly with offline access, and this file is where its tokens go:
// encrypted into calendar_connections, never into Better Auth's auth_account.
//
// Better Auth writes a Google sign-in's tokens through its adapter on three
// paths (better-auth 1.7.7 oauth2/link-account.mjs): a new member's account
// (account.create), a returning member's account (account.update, only the
// values Google sent this time), and the explicit Link Google of a password
// login (either). Every one passes the account database hooks, so:
//
//   before (parkGoogleTokens): the tokens are taken out of what is written,
//     which leaves auth_account's token columns null, and parked in memory
//     under Google's subject id for at most PARK_TTL_MS.
//   after (storeParkedGrant): the parked tokens are taken back by the stored
//     account's subject id, and, when Google sent a refresh token, stored for
//     the account's member by storeCalendarGrant. A new member's account comes
//     after its user, whose own after-hook has linked the member by then (after
//     hooks run in order, after the transaction commits).
//
// Google sends a refresh token only when it asks for consent: a first grant,
// or Reconnect calendar (routes/oauth.ts, prompt=consent). A returning member
// who granted before gets none, and their connection is left as it is; one
// with no connection is sent on to Google's consent screen right after the
// sign-in (consentAfterSignIn below) and then to where the sign-in was going.
// Sign-in never fails because of the calendar: every outcome here is logged
// and that is all.
//
// In memory, like the consents in flight below: hosted runs one
// machine (SAA-227 decision 22), and the after hook runs in the same request
// as the before hook.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { encrypt } from "../lib/crypto.js";
import { logError } from "../lib/safe-error.js";
import { GoogleApiError, listCalendars, selectSearchableCalendars } from "../lib/google-calendar.js";
import { findMemberByAuthUserId, normalizeEmail } from "./membership.js";

export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

type Parked = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  parkedAt: number;
};

const PARK_TTL_MS = 10 * 60 * 1000;
const parked = new Map<string, Parked>();

// The subject id ("sub") from a Google id token. Only a key: Better Auth has
// already verified the token before any hook runs.
function subjectOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const sub = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const asDate = (v: unknown): Date | null => (v instanceof Date ? v : typeof v === "string" || typeof v === "number" ? new Date(v) : null);

// account.create.before and account.update.before. Returns the data with every
// Google token removed, or nothing for another provider or a write that carries
// no token.
export function parkGoogleTokens(data: Record<string, unknown>): { data: Record<string, unknown> } | void {
  if (data.providerId !== "google") return;
  if (!("accessToken" in data) && !("refreshToken" in data) && !("idToken" in data)) return;
  const now = Date.now();
  for (const [key, value] of parked) {
    if (now - value.parkedAt > PARK_TTL_MS) parked.delete(key);
  }
  const subject = asString(data.accountId) ?? subjectOf(data.idToken);
  const accessToken = asString(data.accessToken);
  if (subject && accessToken) {
    parked.set(subject, {
      accessToken,
      refreshToken: asString(data.refreshToken),
      expiresAt: asDate(data.accessTokenExpiresAt),
      scope: asString(data.scope),
      parkedAt: now,
    });
  }
  return {
    data: {
      ...data,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    },
  };
}

export type GrantOutcome =
  | "stored"
  | "no_calendar_scope"
  | "not_own_address"
  | "no_primary_calendar"
  | "no_refresh_token"
  | "nothing_parked"
  | "no_member"
  | "failed"
  | "not_google";

// The member whose sign-in grant came without a refresh token, carried from the
// account hook to the after-hook on Google's callback (auth.ts) on that
// request's own auth context: the object Better Auth hands both hooks.
const CONSENT_AFTER_SIGN_IN = Symbol("consent after sign-in");
type ConsentMember = { accountId: string; memberId: string; email: string };
type RequestContext = { context: object };
type CarriesConsent = { [CONSENT_AFTER_SIGN_IN]?: ConsentMember };

// account.create.after and account.update.after, with the request's auth
// context (null outside a request). The outcome is returned for the checks and
// logged by ids only (SAA-227 decision 11).
export async function storeParkedGrant(account: Record<string, unknown>, request: RequestContext | null): Promise<GrantOutcome> {
  if (account.providerId !== "google") return "not_google";
  const subject = asString(account.accountId);
  const grant = subject ? parked.get(subject) : undefined;
  if (subject) parked.delete(subject);
  if (!grant) return "nothing_parked";
  const userId = asString(account.userId);
  const member = userId ? await findMemberByAuthUserId(userId) : null;
  if (!member || member.removedAt) {
    console.log(`google sign-in: calendar not stored: no active member for this login`);
    return "no_member";
  }
  if (!grant.refreshToken) {
    console.log(`google sign-in: calendar for member=${member.id}: no refresh token (granted before); connection left as it is`);
    if (request) {
      (request.context as CarriesConsent)[CONSENT_AFTER_SIGN_IN] = { accountId: member.accountId, memberId: member.id, email: member.email };
    }
    return "no_refresh_token";
  }
  try {
    const { outcome } = await storeCalendarGrant(
      {
        accountId: member.accountId,
        memberId: member.id,
        memberEmail: member.email,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt ?? new Date(Date.now() + 3600 * 1000),
        scope: grant.scope,
      },
      { unreportedScope: "prove_by_calendar_list" },
    );
    console.log(`google sign-in: calendar for member=${member.id}: ${outcome}`);
    return outcome;
  } catch (err) {
    const status = err instanceof GoogleApiError ? err.status : null;
    console.log(`google sign-in: calendar for member=${member.id}: failed (${err instanceof Error ? err.name : "error"} status=${status ?? "(n/a)"})`);
    return "failed";
  }
}

// Google accounts written before the hooks above, which still hold Google's
// tokens in auth_account (on hosted: the identity-only sign-ins since K, access
// and id tokens unencrypted). Counted always; cleared only with apply. Nothing
// reads them (SAA-198 step 5), and every new write leaves them null.
export async function clearGoogleTokens(apply: boolean): Promise<{ holding: number; cleared: number }> {
  const holding = `"providerId" = 'google' and ("accessToken" is not null or "refreshToken" is not null or "idToken" is not null)`;
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text n from auth_account where ${holding}`);
  const count = Number(rows[0].n);
  if (!apply) return { holding: count, cleared: 0 };
  const res = await pool.query(
    `update auth_account set "accessToken" = null, "refreshToken" = null, "idToken" = null, ` +
      `"accessTokenExpiresAt" = null, "refreshTokenExpiresAt" = null where ${holding}`,
  );
  return { holding: count, cleared: res.rowCount ?? 0 };
}

// Google consents in flight for the calendar: Reconnect calendar's
// (routes/oauth.ts) and the one a sign-in starts (consentAfterSignIn below).
// state -> the member who started it, and, for a sign-in, where that sign-in
// was going. Generated and validated in this same process, deliberately not
// persisted (hosted runs one machine, SAA-227 decision 22), so a consent
// started right before a server restart has to be retried. Single-use: deleted
// when taken. Expired entries are swept on every new entry.
export type PendingConsent = { accountId: string; memberId: string; expiresAt: number; returnTo: string | null };
const pendingConsents = new Map<string, PendingConsent>();
const CONSENT_TTL_MS = 10 * 60 * 1000;
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// The Google client and redirect address Reconnect uses, or null when either is unset.
export function calendarOAuthConfig(): { clientId: string; redirectUri: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  return clientId && redirectUri ? { clientId, redirectUri } : null;
}

// Records a consent in flight and returns Google's consent screen for it:
// calendar.readonly with offline access, consent asked every time, and the
// member's own address as the account Google offers (decision 28 refuses a
// grant for any other).
export function startCalendarConsent(
  oauth: { clientId: string; redirectUri: string },
  member: ConsentMember,
  returnTo: string | null,
): string {
  const now = Date.now();
  for (const [key, value] of pendingConsents) {
    if (value.expiresAt < now) pendingConsents.delete(key);
  }
  const state = randomBytes(16).toString("hex");
  pendingConsents.set(state, { accountId: member.accountId, memberId: member.memberId, expiresAt: now + CONSENT_TTL_MS, returnTo });
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", oauth.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CALENDAR_READONLY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("login_hint", member.email);
  url.searchParams.set("state", state);
  return url.toString();
}

// The consent in flight for a state, removed whatever comes next.
export function takeCalendarConsent(state: string): PendingConsent | undefined {
  const pending = pendingConsents.get(state);
  pendingConsents.delete(state);
  return pending;
}

// The consent in flight for a state when a sign-in started it, removed;
// undefined, with nothing removed, for any other state.
export function takeSignInConsent(state: string): (PendingConsent & { returnTo: string }) | undefined {
  const pending = pendingConsents.get(state);
  if (!pending || pending.returnTo === null) return undefined;
  pendingConsents.delete(state);
  return { ...pending, returnTo: pending.returnTo };
}

// A path on this server: one leading "/" (not "//" or "/\"), resolving to origin.
function isOwnPath(destination: string, origin: string): boolean {
  if (!destination.startsWith("/") || destination.startsWith("//") || destination.startsWith("/\\")) return false;
  try {
    return new URL(destination, origin).origin === origin;
  } catch {
    return false;
  }
}

// After Google's callback (auth.ts): when this request's grant came without a
// refresh token and the member has no calendar connection, Google's consent
// screen, to come back from to the sign-in's own destination. Null when there
// is nothing to ask, when the destination is not a path on this server, when
// Reconnect is not configured, and on any failure, which is logged: the
// sign-in then goes where Better Auth sends it.
export async function consentAfterSignIn(request: RequestContext, destination: string, origin: string): Promise<string | null> {
  const member = (request.context as CarriesConsent)[CONSENT_AFTER_SIGN_IN];
  if (!member) return null;
  if (!isOwnPath(destination, origin)) return null;
  const oauth = calendarOAuthConfig();
  if (!oauth) return null;
  try {
    const [row] = await db
      .select({ id: schema.calendarConnections.id })
      .from(schema.calendarConnections)
      .where(eq(schema.calendarConnections.memberId, member.memberId));
    if (row) return null;
    console.log(`google sign-in: calendar for member=${member.memberId}: no connection; on to Google's consent screen`);
    return startCalendarConsent(oauth, member, destination);
  } catch (err) {
    logError(`google sign-in: calendar for member=${member.memberId}: consent not started`, err);
    return null;
  }
}

// Whether the scopes Google reported for a grant include calendar.readonly.
// Space-separated in Google's token reply, comma-separated where Better Auth
// has joined them. No scope reported is no: it is never assumed. Google's
// tokeninfo could say, but is documented for id tokens only (open list).
function hasCalendarScope(scope: string | null): boolean {
  return !!scope && scope.split(/[\s,]+/).includes(CALENDAR_READONLY_SCOPE);
}

// Stores a grant as the member's calendar connection, after two checks: the
// scope Google reported includes calendar.readonly (a member may approve sign-in
// without the calendar, and a returning member's sign-in reports no scope), and
// decision 28's, that the grant's primary calendar is the member's own sign-in
// address. Otherwise nothing is stored. Shared by sign-in (above) and Reconnect
// calendar (routes/oauth.ts). Counts and ids only in the log (SAA-227 decision
// 11): the calendar list holds addresses and names.
//
// A grant that reports no scope at all (unreportedScope):
//   "refuse" (the default, and Reconnect calendar's): nothing is stored.
//   "prove_by_calendar_list" (sign-in's only): Better Auth's update path, a
//     returning member whom Google asked again, carries no scope, so the grant
//     is proven by a calendarList that succeeds, and stored with
//     calendar.readonly as its scope. That proof holds because of what sign-in
//     asks for: identity plus calendar.readonly and nothing else (auth.ts), with
//     includeGrantedScopes off, so no scope granted earlier rides along; Google
//     gives no checkbox when the only scope beyond sign-in is one (step 0b,
//     Google's granular-permissions page), so the member approves the whole
//     request or none of it; and nothing here ever asks for
//     calendar.calendarlist.readonly, the one other scope that would let
//     calendarList answer without calendar access. A refused calendarList (401
//     or 403) is no_calendar_scope.
// A scope that is reported but lacks calendar.readonly is refused either way.
export async function storeCalendarGrant(
  grant: {
    accountId: string;
    memberId: string;
    memberEmail: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scope: string | null;
  },
  opts: { unreportedScope: "refuse" | "prove_by_calendar_list" } = { unreportedScope: "refuse" },
): Promise<{ outcome: "stored" | "not_own_address" | "no_primary_calendar" | "no_calendar_scope"; calendarEmail: string | null }> {
  const proveByList = !grant.scope && opts.unreportedScope === "prove_by_calendar_list";
  if (!proveByList && !hasCalendarScope(grant.scope)) {
    console.log(`calendar grant: member=${grant.memberId}: no calendar.readonly in the scope Google reported; nothing stored`);
    return { outcome: "no_calendar_scope", calendarEmail: null };
  }
  // calendarList, not the userinfo endpoint — see listCalendars' own comment.
  let calendars;
  try {
    calendars = await listCalendars(grant.accessToken);
  } catch (err) {
    if (proveByList && err instanceof GoogleApiError && (err.status === 401 || err.status === 403)) {
      console.log(`calendar grant: member=${grant.memberId}: no scope reported and calendarList refused (${err.status}); nothing stored`);
      return { outcome: "no_calendar_scope", calendarEmail: null };
    }
    throw err;
  }
  if (proveByList) {
    console.log(`calendar grant: member=${grant.memberId}: no scope reported; calendarList answered, so the grant is calendar.readonly`);
  }
  console.log(`calendar grant: calendarList for member=${grant.memberId}: ${calendars.length} calendar(s)`);
  const primary = calendars.find((c) => c.primary);
  if (!primary) return { outcome: "no_primary_calendar", calendarEmail: null };
  const calendarEmail = primary.id;
  if (normalizeEmail(calendarEmail) !== normalizeEmail(grant.memberEmail)) {
    return { outcome: "not_own_address", calendarEmail: null };
  }

  // The list a match actually searches — computed once here, stored, not
  // recomputed per match.
  const selection = selectSearchableCalendars(calendars);
  console.log(
    `calendar grant: searchable calendars for member=${grant.memberId}: ` +
      `${selection.included.length} included, ${selection.excluded.length} excluded`,
  );

  // UNIQUE(member_id, calendar_email) is exactly the conflict target here —
  // race-free in one statement.
  const values = {
    accountId: grant.accountId,
    memberId: grant.memberId,
    calendarEmail,
    accessToken: encrypt(grant.accessToken),
    refreshToken: encrypt(grant.refreshToken),
    tokenExpiresAt: grant.expiresAt,
    scope: proveByList ? CALENDAR_READONLY_SCOPE : grant.scope,
    searchedCalendarIds: selection.included,
  };
  await db
    .insert(schema.calendarConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.calendarConnections.memberId, schema.calendarConnections.calendarEmail],
      set: values,
    });
  return { outcome: "stored", calendarEmail };
}
