// Connects a Google Calendar account (SAA-115 step 1). Mounted at `/` in
// index.ts, like transcriptRouter — its paths are fully qualified, not
// nested under /accounts/:accountId.

import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import { db, schema } from "../db/index.js";
import { accessOf, sessionMember } from "../access/authenticate.js";
import { authConfigFromEnv, getAuth } from "../auth/auth.js";
import {
  calendarOAuthConfig,
  isSignInConsentState,
  signInConsentReturnTo,
  startCalendarConsent,
  storeCalendarGrant,
  takeCalendarConsent,
  type PendingConsent,
} from "../auth/google-calendar-grant.js";
import { asyncHandler, HttpError, parseQuery } from "../lib/http.js";
import { exchangeCode } from "../lib/google-calendar.js";
import { logError } from "../lib/safe-error.js";

export const oauthRouter = Router();

function oauthConfig(): { clientId: string; redirectUri: string } {
  const config = calendarOAuthConfig();
  if (!config) {
    throw new HttpError(500, "google_oauth_not_configured");
  }
  return config;
}

oauthRouter.get(
  "/oauth/google/connect",
  asyncHandler(async (req, res) => {
    // Mounted behind requireSession (app.ts): any member, signed in in this
    // browser, connects their own calendar (SAA-227 decision 9). The account
    // and the member come from the session. /callback is deliberately not
    // behind it: it runs its own session check against the state's member.
    const { accountId, memberId, email } = accessOf(req);
    res.redirect(startCalendarConsent(oauthConfig(), { accountId, memberId, email }, null));
  }),
);

// A consent a sign-in started (auth/google-calendar-grant.ts
// consentAfterSignIn): what came of it, for the log. Nothing is stored unless
// the member who started it is signed in here, Google sent a code, and the
// grant passes storeCalendarGrant's checks.
async function signInConsentOutcome(req: Request, pending: PendingConsent): Promise<string> {
  if (pending.expiresAt < Date.now()) return "expired";
  const member = await sessionMember(req);
  if (!member || member.memberId !== pending.memberId) return "not_this_member";
  const code = typeof req.query.code === "string" && req.query.code ? req.query.code : null;
  if (!code) return "no_code";
  try {
    const tokens = await exchangeCode(code, oauthConfig().redirectUri);
    if (!tokens.refreshToken) return "no_refresh_token";
    const { outcome } = await storeCalendarGrant({
      accountId: pending.accountId,
      memberId: pending.memberId,
      memberEmail: member.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });
    return outcome;
  } catch (err) {
    logError(`calendar consent after sign-in for member=${pending.memberId}: failed`, err);
    return "failed";
  }
}

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

oauthRouter.get(
  "/oauth/google/callback",
  asyncHandler(async (req, res) => {
    // A consent a sign-in started: whatever Google answered, and whether or not
    // this process still holds its entry, the browser that made the sign-in
    // goes on to where that sign-in was going. The destination comes from the
    // signed state, checked again here (MAC, expiry, this session, a path on
    // this server). A state that fails any of those is treated as Reconnect's.
    const rawState = typeof req.query.state === "string" ? req.query.state : "";
    if (isSignInConsentState(rawState)) {
      const auth = authConfigFromEnv();
      const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
      const returnTo = signInConsentReturnTo(rawState, auth.secret, session?.session.id ?? null, new URL(auth.baseURL).origin);
      if (returnTo) {
        const pending = takeCalendarConsent(rawState);
        if (pending) {
          const outcome = await signInConsentOutcome(req, pending);
          console.log(`calendar consent after sign-in for member=${pending.memberId}: ${outcome}`);
        } else {
          console.log("calendar consent after sign-in: state no longer held here; on to the sign-in's destination");
        }
        res.redirect(returnTo);
        return;
      }
    }

    const { code, state } = parseQuery(callbackQuerySchema, req);

    const pending = takeCalendarConsent(state); // single-use regardless of outcome
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
