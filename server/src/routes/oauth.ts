// Connects a Google Calendar account (SAA-115 step 1). Mounted at `/` in
// index.ts, like transcriptRouter — its paths are fully qualified, not
// nested under /accounts/:accountId.

import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { accessOf, sessionMember } from "../access/authenticate.js";
import { CALENDAR_READONLY_SCOPE, storeCalendarGrant } from "../auth/google-calendar-grant.js";
import { asyncHandler, HttpError, parseQuery } from "../lib/http.js";
import { exchangeCode } from "../lib/google-calendar.js";

export const oauthRouter = Router();

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// state -> {accountId, memberId, expiresAt}. Generated and validated in this
// same process, deliberately not persisted (decision 1's ethos on the issue:
// no polling, no sync cursor, no jobs table — this is one flow, run once per
// calendar connection; hosted runs one machine, SAA-227 decision 22). The
// member is who started it, and the callback requires that same member signed
// in. Single-use: deleted on lookup.
// Cost of the simpler choice: a connect attempt started right before a
// server restart has to be retried.
const pendingStates = new Map<string, { accountId: string; memberId: string; expiresAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;

// A connect that's started and never completed (closed tab, denied
// consent) would otherwise sit in the map until restart — trivial for one
// user, unbounded in principle. Swept on every new entry rather than on a
// timer, so there's no extra scheduled thing running for a flow used this
// rarely.
function setState(state: string, accountId: string, memberId: string): void {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (value.expiresAt < now) pendingStates.delete(key);
  }
  pendingStates.set(state, { accountId, memberId, expiresAt: now + STATE_TTL_MS });
}

function oauthConfig(): { clientId: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new HttpError(500, "google_oauth_not_configured");
  }
  return { clientId, redirectUri };
}

oauthRouter.get(
  "/oauth/google/connect",
  asyncHandler(async (req, res) => {
    // Mounted behind requireSession (app.ts): any member, signed in in this
    // browser, connects their own calendar (SAA-227 decision 9). The account
    // and the member come from the session. /callback is deliberately not
    // behind it: it runs its own session check against the state's member.
    const { accountId, memberId } = accessOf(req);

    const { clientId, redirectUri } = oauthConfig();
    const state = randomBytes(16).toString("hex");
    setState(state, accountId, memberId);

    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", CALENDAR_READONLY_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  }),
);

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

oauthRouter.get(
  "/oauth/google/callback",
  asyncHandler(async (req, res) => {
    const { code, state } = parseQuery(callbackQuerySchema, req);

    const pending = pendingStates.get(state);
    pendingStates.delete(state); // single-use regardless of outcome
    if (!pending || pending.expiresAt < Date.now()) {
      throw new HttpError(400, "invalid_or_expired_state");
    }
    // The member who started this connect, signed in in this browser now
    // (SAA-227 decision 22). Checked before Google is asked anything, so a
    // code that reaches another member's session is never exchanged.
    const member = await sessionMember(req);
    if (!member || member.memberId !== pending.memberId) {
      throw new HttpError(403, "calendar_connect_not_this_member");
    }

    const { redirectUri } = oauthConfig();
    const tokens = await exchangeCode(code, redirectUri);
    if (!tokens.refreshToken) {
      // Only happens if Google re-consents without issuing a new refresh
      // token (e.g. prompt=consent was somehow bypassed) — access_type=
      // offline + prompt=consent above should always produce one.
      throw new HttpError(502, "google_did_not_return_a_refresh_token");
    }
    // The same store as sign-in's (auth/google-calendar-grant.ts), with decision
    // 28's check: only the member's own calendar. Anything else is refused, and
    // nothing is stored.
    const { outcome, calendarEmail } = await storeCalendarGrant({
      accountId: pending.accountId,
      memberId: pending.memberId,
      memberEmail: member.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });
    if (outcome === "no_calendar_scope") throw new HttpError(403, "calendar_scope_not_granted");
    if (outcome === "no_primary_calendar") throw new HttpError(502, "no_primary_calendar_in_calendarlist");
    if (outcome === "not_own_address") throw new HttpError(403, "calendar_not_own_address");

    res
      .status(200)
      .type("text/plain")
      .send(`Connected ${calendarEmail}. You can close this tab.`);
  }),
);

// Whether the signed-in member has a calendar connection, for /login's
// "Reconnect calendar" (SAA-198 step 5). Mounted behind requireSession (app.ts).
// A grant Google later refuses is removed by the match job (match-calendar.ts),
// so "no row" covers both a lost and a revoked connection.
oauthRouter.get(
  "/oauth/google/status",
  asyncHandler(async (req, res) => {
    const { memberId } = accessOf(req);
    const [row] = await db
      .select({ calendarEmail: schema.calendarConnections.calendarEmail })
      .from(schema.calendarConnections)
      .where(eq(schema.calendarConnections.memberId, memberId));
    res.json(row ? { connected: true, calendarEmail: row.calendarEmail } : { connected: false, calendarEmail: null });
  }),
);
