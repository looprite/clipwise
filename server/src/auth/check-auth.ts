// Live check for sign-in: Better Auth mounted on an in-process Express server
// against a real database. Covers password sign-in, closed sign-up, the
// member gate, removal revoking sessions, rate limiting (including a client
// that picks its own forwarding header), anonymous client registration, the
// OAuth discovery document, and connecting a member's own calendar from their
// signed-in session (SAA-227 part F, against the real app).
//
// WRITES to the database it is pointed at (throwaway members, users and OAuth
// clients, all tagged and removed at the end), so it refuses to run unless the
// caller says the database is a scratch one. The database must already be
// provisioned (db:provision) and have its account (auth init-account).
//
// One write is not confined to its own rows: the clear-google-tokens --apply
// case (SAA-198 step 5) clears the Google tokens of EVERY Google account in
// auth_account on the database it runs on, as the command itself does, not
// only the fixture row it inserts. scratch-db.sh's guard is what confines that
// to the scratch branch. A sign-in done on that branch before a run loses its
// Google tokens with it.
//
// Usage:
//   CLIPWISE_CHECK_SCRATCH_DB=1 tsx src/auth/check-auth.ts
// with DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL and
// AUTH_PASSWORD_ENABLED=true set (see .env.example).

import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, pool, schema } from "../db/index.js";
import { authConfigFromEnv, createAuth, getAuth } from "./auth.js";
import { addMember, createPasswordLogin, removeMember, requireAccount, Refusal } from "./members.js";
import { findMemberByEmail } from "./membership.js";
import { mountAuth } from "./mount.js";

if (process.env.CLIPWISE_CHECK_SCRATCH_DB !== "1") {
  process.stderr.write(
    "check-auth: refusing to run — it writes to the database. Point DATABASE_URL at a scratch database and set CLIPWISE_CHECK_SCRATCH_DB=1.\n",
  );
  process.exit(2);
}

const tag = randomBytes(4).toString("hex");
const emailFor = (who: string) => `${who}-${tag}@clipwise.test`;
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const cfg = authConfigFromEnv();
const origin = cfg.baseURL;

let failed = 0;
let total = 0;
function record(ok: boolean, name: string, detail = ""): void {
  total++;
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

type Reply = { status: number; headers: Headers; json: unknown; cookie: string };
async function call(
  base: string,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: {
      origin,
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { status: res.status, headers: res.headers, json, cookie };
}

const signIn = (base: string, email: string, password: string, headers?: Record<string, string>) =>
  call(base, "POST", "/api/auth/sign-in/email", { body: { email, password }, headers });

async function userCount(email: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text n from auth_user where email = $1`, [email]);
  return Number(rows[0].n);
}

async function cleanup(): Promise<void> {
  try {
    for (const like of [`%-${tag}@clipwise.test`, `%-${tag}@outside.test`]) {
      await pool.query(`delete from auth_session where "userId" in (select id from auth_user where email like $1)`, [like]);
      await pool.query(`delete from auth_account where "userId" in (select id from auth_user where email like $1)`, [like]);
      await pool.query(`delete from auth_user where email like $1`, [like]);
      await pool.query(`delete from calendar_connections where member_id in (select id from account_members where email like $1)`, [like]);
      await pool.query(`delete from account_members where email like $1`, [like]);
    }
    await pool.query(`delete from "oauthClient" where name like $1`, [`check-${tag}%`]);
  } catch (err) {
    process.stderr.write(`check-auth: cleanup problem: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function main(): Promise<void> {
  const account = await requireAccount();
  process.stdout.write(`account: ${account.name}; tag ${tag}\n`);

  const app = express();
  mountAuth(app); // before any body parser, as in index.ts
  app.use(express.json());
  const srv = await listen(app);

  try {
    // --- sign-in with a password -------------------------------------------
    const memberEmail = emailFor("member");
    await addMember({ email: memberEmail, role: "member", name: "Check Member" });
    await createPasswordLogin(memberEmail, "Check Member", PASSWORD);

    const good = await signIn(srv.base, memberEmail, PASSWORD, { "x-forwarded-for": "198.51.100.1" });
    record(good.status === 200 && good.cookie.length > 0, "a member signs in with the right password and gets a session", `status ${good.status}`);

    const session = await call(srv.base, "GET", "/api/auth/get-session", { cookie: good.cookie });
    const sessionEmail = (session.json as { user?: { email?: string } } | null)?.user?.email;
    record(sessionEmail === memberEmail, "that session resolves to the member", `got ${sessionEmail ?? "no user"}`);

    const bad = await signIn(srv.base, memberEmail, "not-the-password-0000");
    record(bad.status === 401, "a wrong password is refused", `status ${bad.status}`);

    // --- no sign-up ---------------------------------------------------------
    const strangerEmail = emailFor("stranger");
    const signup = await call(srv.base, "POST", "/api/auth/sign-up/email", {
      body: { email: strangerEmail, password: PASSWORD, name: "Stranger" },
    });
    record(signup.status >= 400 && signup.status < 500, "the sign-up endpoint is closed", `status ${signup.status}`);
    record((await userCount(strangerEmail)) === 0, "and no user was created for the would-be sign-up");

    // --- the member gate (hook), independent of the endpoint ---------------
    const ctx = await getAuth().$context;
    let strangerRefused = false;
    try {
      await ctx.internalAdapter.createUser({ email: strangerEmail, name: "Stranger", emailVerified: true }, { method: "admin" });
    } catch {
      strangerRefused = true;
    }
    record(strangerRefused && (await userCount(strangerEmail)) === 0, "an email that is not a member cannot become a user, even by direct creation");

    const wrongDomainEmail = emailFor("wrongdomain");
    await addMember({ email: wrongDomainEmail, role: "member", name: null });
    const restricted = createAuth({ ...cfg, allowedDomain: "looprite.ai" });
    let domainRefused = false;
    try {
      await (await restricted.$context).internalAdapter.createUser(
        { email: wrongDomainEmail, name: "Wrong Domain", emailVerified: true },
        { method: "admin" },
      );
    } catch {
      domainRefused = true;
    }
    record(domainRefused && (await userCount(wrongDomainEmail)) === 0, "a member whose email is off the allowed domain is refused");

    const unverifiedEmail = emailFor("unverified");
    await addMember({ email: unverifiedEmail, role: "member", name: null });
    let unverifiedRefused = false;
    try {
      await ctx.internalAdapter.createUser({ email: unverifiedEmail, name: "Unverified", emailVerified: false }, { method: "admin" });
    } catch {
      unverifiedRefused = true;
    }
    record(unverifiedRefused && (await userCount(unverifiedEmail)) === 0, "a member with an unverified email is refused");

    // --- calendar connect, per member (SAA-227 part F) ----------------------
    // Against the real app (buildApp), with its session guard. Google is
    // answered in this process: fetch is wrapped so the token and calendarList
    // requests the server makes get a placeholder reply, and every other request
    // goes out as usual. Nothing reaches Google, and the app is unchanged. The
    // Google settings are placeholders set for this section only; Better Auth was
    // built above without them, so Google sign-in stays off for the cases below.
    const calEnv = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "CALENDAR_TOKEN_ENCRYPTION_KEY"] as const;
    const savedEnv = calEnv.map((k) => [k, process.env[k]] as const);
    process.env.GOOGLE_CLIENT_ID = "check-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "check-placeholder";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = `${origin}/oauth/google/callback`;
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const realFetch = globalThis.fetch;
    let googleCalls = 0;
    let primaryAddress = "";
    let tokenRefusal: { status: number; error: string } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        googleCalls++;
        // A refused refresh, as Google sends one (RFC 6749 5.2), for the
        // invalid_grant cases; null otherwise.
        if (tokenRefusal) return Response.json({ error: tokenRefusal.error, error_description: "check" }, { status: tokenRefusal.status });
        return Response.json({ access_token: "check-access", refresh_token: "check-refresh", expires_in: 3600, scope: CALENDAR_SCOPE });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) {
        googleCalls++;
        return Response.json({ items: [{ id: primaryAddress, primary: true, accessRole: "owner" }] });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const { app: realApp } = await buildApp();
    const rsrv = await listen(realApp);
    try {
      // GET /oauth/google/connect with a session cookie, not followed: where it
      // sends the browser, and the state it issued.
      const startConnect = async (cookie: string) => {
        const res = await realFetch(`${rsrv.base}/oauth/google/connect`, { headers: { origin, cookie }, redirect: "manual" });
        const location = res.headers.get("location");
        const u = location ? new URL(location) : null;
        return {
          status: res.status,
          atGoogle: u?.host === "accounts.google.com",
          scope: u?.searchParams.get("scope") ?? null,
          state: u?.searchParams.get("state") ?? null,
        };
      };

      // GET /oauth/google/callback as Google's redirect would arrive, with a
      // session cookie. No state (connect refused) is status 0.
      const callback = async (state: string | null, cookie: string): Promise<{ status: number; error: unknown }> => {
        if (!state) return { status: 0, error: "no state" };
        const res = await realFetch(`${rsrv.base}/oauth/google/callback?code=check-code&state=${encodeURIComponent(state)}`, {
          headers: { origin, cookie },
          redirect: "manual",
        });
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        return { status: res.status, error: body?.error ?? null };
      };

      const rowsOfMember = async (email: string): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(
          `select count(*)::text n from calendar_connections c join account_members m on m.id = c.member_id where m.email = $1`,
          [email],
        );
        return Number(rows[0].n);
      };
      const rowsOfAddress = async (address: string): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(`select count(*)::text n from calendar_connections where calendar_email = $1`, [address]);
        return Number(rows[0].n);
      };

      // memberEmail is a plain member (role member), signed in above as `good`.
      const otherEmail = emailFor("calendar-other");
      await addMember({ email: otherEmail, role: "member", name: "Calendar Other" });
      await createPasswordLogin(otherEmail, "Calendar Other", PASSWORD);
      const other = await signIn(srv.base, otherEmail, PASSWORD);

      // 1. A member who is not an admin can start a connection.
      const s1 = await startConnect(good.cookie);
      record(
        s1.status === 302 && s1.atGoogle && s1.scope === CALENDAR_SCOPE && !!s1.state,
        "calendar connect: a signed-in member who is not an admin starts a connection at Google, for calendar.readonly",
        `status ${s1.status}`,
      );

      // 2. The member's state, arriving with another member's session.
      primaryAddress = memberEmail;
      const before = googleCalls;
      const wrongMember = await callback(s1.state, other.cookie);
      const wrongMemberRows = await rowsOfMember(memberEmail);
      const wrongMemberOtherRows = await rowsOfMember(otherEmail);
      record(
        wrongMember.status === 403 && googleCalls - before === 0 && wrongMemberRows === 0 && wrongMemberOtherRows === 0,
        "calendar callback: another member's session is refused (403) before Google is asked, and nothing is stored",
        `status ${wrongMember.status} ${String(wrongMember.error)}, Google calls ${googleCalls - before}, rows for the member ${wrongMemberRows}, for the other ${wrongMemberOtherRows}`,
      );

      // 3. The member's own session, but Google's primary address is someone else's.
      const s2 = await startConnect(good.cookie);
      primaryAddress = emailFor("calendar-someone-else");
      const notOwn = await callback(s2.state, good.cookie);
      const notOwnMemberRows = await rowsOfMember(memberEmail);
      const notOwnAddressRows = await rowsOfAddress(primaryAddress);
      record(
        notOwn.status === 403 && notOwnMemberRows === 0 && notOwnAddressRows === 0,
        "calendar callback: a Google account whose primary address is not the member's own is refused (403), and no row is stored",
        `status ${notOwn.status} ${String(notOwn.error)}, rows for the member ${notOwnMemberRows}, for the address ${notOwnAddressRows}`,
      );

      // 4. The control for 2 and 3: own session, own address, stored.
      const s3 = await startConnect(good.cookie);
      primaryAddress = memberEmail;
      const own = await callback(s3.state, good.cookie);
      const ownRows = await rowsOfMember(memberEmail);
      record(
        own.status === 200 && ownRows === 1,
        "calendar callback: the member's own session and own address are stored as their connection (the control for both refusals)",
        `status ${own.status} ${String(own.error)}, rows for the member ${ownRows}`,
      );

      // 5–7. The scope a grant carries (SAA-198 step 5): stored only when
      // calendar.readonly is among the scopes Google reported; a grant that
      // reported none stores nothing. storeCalendarGrant is what sign-in's hook
      // and Reconnect calendar's callback both store through. Imported here, so
      // code without it fails these cases rather than the run.
      const grantModule = await import("./google-calendar-grant.js").catch(() => null);
      const scopeEmail = emailFor("calendar-scope");
      await addMember({ email: scopeEmail, role: "member", name: null });
      const scopeMember = await findMemberByEmail(scopeEmail);
      const tryGrant = async (scope: string | null) => {
        await pool.query(`delete from calendar_connections where member_id = $1`, [scopeMember!.id]);
        primaryAddress = scopeEmail;
        let outcome = "(no storeCalendarGrant)";
        try {
          outcome = (
            await grantModule!.storeCalendarGrant({
              accountId: scopeMember!.accountId,
              memberId: scopeMember!.id,
              memberEmail: scopeEmail,
              accessToken: "check-access",
              refreshToken: "check-refresh",
              expiresAt: new Date(Date.now() + 3600 * 1000),
              scope: scope as string,
            })
          ).outcome;
        } catch (err) {
          outcome = `threw ${err instanceof Error ? err.name : String(err)}`;
        }
        return { outcome, rows: await rowsOfMember(scopeEmail) };
      };
      const g5 = await tryGrant(`openid email ${CALENDAR_SCOPE}`);
      record(
        g5.outcome === "stored" && g5.rows === 1,
        "calendar scope: a grant whose reported scope includes calendar.readonly is stored",
        `outcome ${g5.outcome}, rows ${g5.rows}`,
      );
      const g6 = await tryGrant("openid email profile");
      record(
        g6.outcome === "no_calendar_scope" && g6.rows === 0,
        "calendar scope: a reported scope without calendar.readonly stores nothing (no_calendar_scope)",
        `outcome ${g6.outcome}, rows ${g6.rows}`,
      );
      const g7 = await tryGrant(null);
      record(
        g7.outcome === "no_calendar_scope" && g7.rows === 0,
        "calendar scope, Reconnect's strict check: no reported scope stores nothing (no_calendar_scope)",
        `outcome ${g7.outcome}, rows ${g7.rows}`,
      );

      // 8–9. A refresh Google refuses with invalid_grant removes the connection,
      // so the member is shown Reconnect calendar; any other refusal keeps it
      // and is thrown, for the job to retry (the control).
      const { resolveCalendarConnection } = await import("../pipeline/match-calendar.js");
      const { encrypt } = await import("../lib/crypto.js");
      const expiredRow = async () => {
        await pool.query(`delete from calendar_connections where member_id = $1`, [scopeMember!.id]);
        await db.insert(schema.calendarConnections).values({
          accountId: scopeMember!.accountId,
          memberId: scopeMember!.id,
          calendarEmail: scopeEmail,
          accessToken: encrypt("check-expired-access"),
          refreshToken: encrypt("check-revoked-refresh"),
          tokenExpiresAt: new Date(Date.now() - 60_000),
          scope: CALENDAR_SCOPE,
          searchedCalendarIds: [scopeEmail],
        });
      };
      const resolveWith = async (refusal: { status: number; error: string }) => {
        await expiredRow();
        tokenRefusal = refusal;
        let result = "";
        try {
          const r = await resolveCalendarConnection(scopeMember!.id);
          result = "reason" in r ? r.reason : "connection";
        } catch (err) {
          result = `threw ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          tokenRefusal = null;
        }
        return { result, rows: await rowsOfMember(scopeEmail) };
      };
      const revoked = await resolveWith({ status: 400, error: "invalid_grant" });
      record(
        revoked.result === "not_connected" && revoked.rows === 0,
        "calendar refresh refused with invalid_grant: the connection is removed and the capture has no calendar",
        `result ${revoked.result}, rows ${revoked.rows}`,
      );
      const flaky = await resolveWith({ status: 500, error: "server_error" });
      record(
        flaky.result.startsWith("threw") && flaky.rows === 1,
        "calendar refresh failing another way: the connection stays and the error is thrown (the control)",
        `result ${flaky.result}, rows ${flaky.rows}`,
      );

      // 10–12. GET /oauth/google/status, for /login's Reconnect calendar.
      const status = async (cookie: string | null) => {
        const res = await realFetch(`${rsrv.base}/oauth/google/status`, { headers: { origin, ...(cookie ? { cookie } : {}) } });
        return { status: res.status, body: (await res.json().catch(() => null)) as { connected?: unknown; calendarEmail?: unknown } | null };
      };
      const sConnected = await status(good.cookie);
      record(
        sConnected.status === 200 && sConnected.body?.connected === true && sConnected.body?.calendarEmail === memberEmail,
        "calendar status: a member with a connection is told it is connected, and to which address",
        `status ${sConnected.status} ${JSON.stringify(sConnected.body)}`,
      );
      const sMissing = await status(other.cookie);
      record(
        sMissing.status === 200 && sMissing.body?.connected === false,
        "calendar status: a member with none is told it is not connected (never another member's)",
        `status ${sMissing.status} ${JSON.stringify(sMissing.body)}`,
      );
      const sAnon = await status(null);
      record(sAnon.status === 401, "calendar status: without a session it is refused", `status ${sAnon.status}`);

      // 13. /login: Reconnect calendar, shown by the status above, in place of
      // the always-on Connect calendar.
      const login = await (await realFetch(`${rsrv.base}/login`)).text();
      record(
        login.includes(">Reconnect calendar</button>") && login.includes("/oauth/google/status") && !login.includes(">Connect calendar</button>"),
        "/login offers Reconnect calendar from the member's calendar status, and no longer an always-on Connect calendar",
      );

      // 14–17. /consent: the recorder's own wording, and claude.ai's unchanged.
      const page = async (clientId: string) => (await (await realFetch(`${rsrv.base}/consent?client_id=${encodeURIComponent(clientId)}&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback`)).text());
      const once = (html: string, s: string) => html.split(s).length - 1 === 1;
      const listClosed = (html: string) => {
        const count = (s: string) => html.split(s).length - 1;
        return count("<ul>") === 1 && count("</ul>") === 1 && count("<li>") === count("</li>") && count("<li>") > 0
          && html.indexOf("<ul>") < html.indexOf("<li>") && html.lastIndexOf("</li>") < html.indexOf("</ul>");
      };
      const recorderPage = await page("clipwise-recorder");
      const recorderSentences = [
        "<h1>Allow Clipwise Recorder?</h1>",
        "Clipwise Recorder on this Mac wants to connect to Clipwise.",
        "It will send you back to",
        "Only continue if you started this from Clipwise on your Mac.",
        "It will be able to:",
        "<li>add the calls you record on this Mac to your recordings, private to you,</li>",
        "<li>see when each one has finished processing,</li>",
        "<li>save a recording's transcript, and move your own recordings to the trash, restore them, or delete them for good.</li>",
        "It can't search or read your team's calls, and it can't see anyone else's recordings.",
      ];
      const recorderMissing = recorderSentences.filter((s) => !once(recorderPage, s));
      record(recorderMissing.length === 0, "consent, recorder: each sentence of its own wording appears exactly once", `not exactly once: ${JSON.stringify(recorderMissing)}`);
      record(listClosed(recorderPage), "consent, recorder: the list of what it can do is one closed <ul>, every <li> closed");
      const claudeWords = ["cannot change anything", "Claude app you trust", "search the moments", "read those calls"];
      const leaked = claudeWords.filter((w) => recorderPage.includes(w));
      record(leaked.length === 0, "consent, recorder: none of the claude.ai wording appears", `found: ${JSON.stringify(leaked)}`);
      const claudePage = await page("some-claude-client");
      const claudeSentences = [
        "<h1>Allow access?</h1>",
        "wants to connect to Clipwise.",
        "Only continue if you started this from a Claude app you trust.",
        "<li>search the moments of the calls you recorded and the calls your team has shared,</li>",
        "<li>read those calls' transcripts.</li>",
        "It cannot change anything, and it cannot see other people's private calls.",
      ];
      const claudeMissing = claudeSentences.filter((s) => !once(claudePage, s));
      record(
        claudeMissing.length === 0 && listClosed(claudePage) && !claudePage.includes("Clipwise Recorder"),
        "consent, claude.ai: its wording unchanged, each sentence exactly once, the list closed, nothing of the recorder's",
        `not exactly once: ${JSON.stringify(claudeMissing)}`,
      );
    } finally {
      await rsrv.close();
      globalThis.fetch = realFetch;
      for (const [k, v] of savedEnv) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // --- removal ------------------------------------------------------------
    const removed = await removeMember(memberEmail);
    record(removed.revoked, "removing a member reports their sessions revoked");
    const after = await call(srv.base, "GET", "/api/auth/get-session", { cookie: good.cookie });
    const stillThere = (after.json as { user?: unknown } | null)?.user;
    record(!stillThere, "the removed member's existing session no longer resolves", `status ${after.status}`);
    const again = await signIn(srv.base, memberEmail, PASSWORD, { "x-forwarded-for": "198.51.100.2" });
    record(again.status >= 400 && !again.cookie, "and they cannot sign in again", `status ${again.status}`);

    const admins = await db
      .select()
      .from(schema.accountMembers)
      .where(sql`${schema.accountMembers.role} = 'admin' and ${schema.accountMembers.removedAt} is null`);
    if (admins.length === 1) {
      let lastAdminRefused = false;
      try {
        await removeMember(admins[0].email);
      } catch (err) {
        lastAdminRefused = err instanceof Refusal;
      }
      record(lastAdminRefused, "the last admin cannot be removed");
    } else {
      process.stdout.write(`skip the last-admin case (${admins.length} active admins in this database)\n`);
    }

    // --- rate limiting ------------------------------------------------------
    const target = emailFor("ratelimit");
    await addMember({ email: target, role: "member", name: null });
    await createPasswordLogin(target, "Rate Limit", PASSWORD);

    // Same address, wrong password: 10 allowed per 300 s, the 11th is limited.
    const burst: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await signIn(srv.base, target, "wrong-password-000", { "x-forwarded-for": "198.51.100.50" });
      burst.push(r.status);
      retryAfter ??= r.headers.get("x-retry-after");
    }
    // The forwarding header above is ignored (direct connection): the bucket is
    // the socket address, so the count is shared with the spoof test below.
    const limitedAt = burst.indexOf(429);
    record(limitedAt >= 1 && limitedAt <= 10 && burst.slice(0, limitedAt).every((s) => s === 401), "repeated wrong passwords are rate limited", `statuses ${burst.join(",")}`);
    record(retryAfter !== null, "a limited response says when to retry (X-Retry-After)", `got ${retryAfter}`);

    // A client picking a new forwarding address each time must not get a new bucket.
    const spoof: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await signIn(srv.base, target, "wrong-password-000", { "x-forwarded-for": `203.0.113.${i + 10}` });
      spoof.push(r.status);
    }
    record(spoof.every((s) => s === 429), "changing x-forwarded-for does not buy a fresh allowance", `statuses ${spoof.join(",")}`);

    // Configured behind a proxy: a request without the proxy's header is refused.
    const proxied = express();
    mountAuth(proxied, createAuth({ ...cfg, ipAddressHeader: "fly-client-ip" }), "fly-client-ip");
    const psrv = await listen(proxied);
    try {
      const missing = await signIn(psrv.base, target, PASSWORD);
      record(missing.status === 400, "with a proxy header configured, a request without it is refused (fails closed)", `status ${missing.status}`);
      const present = await signIn(psrv.base, target, PASSWORD, { "fly-client-ip": "198.51.100.77" });
      record(present.status === 200, "and one carrying it is served", `status ${present.status}`);
    } finally {
      await psrv.close();
    }

    // --- password sign-in off ----------------------------------------------
    // Its own address bucket: the counters are shared by every instance in
    // this process, and the address above has used up its sign-in allowance.
    const nopw = express();
    mountAuth(nopw, createAuth({ ...cfg, passwordEnabled: false, ipAddressHeader: "x-test-ip" }), "x-test-ip");
    const nsrv = await listen(nopw);
    try {
      const r = await signIn(nsrv.base, target, PASSWORD, { "x-test-ip": "198.51.100.99" });
      // The route stays but refuses ("Email and password is not enabled").
      record(r.status >= 400 && r.status < 500 && !r.cookie, "with AUTH_PASSWORD_ENABLED off a correct password still gets no session", `status ${r.status}`);
    } finally {
      await nsrv.close();
    }

    // --- Google sign-in -----------------------------------------------------
    // An instance with Google configured and the domain restricted. The client
    // ID and secret are placeholders: nothing here reaches Google. Building the
    // authorization URL needs no network, and a Google sign-up creates its user
    // through internalAdapter.createUser with an oauth source
    // (better-auth oauth2/link-account.mjs:275-281), which is what the cases
    // below call.
    const off = await call(srv.base, "POST", "/api/auth/sign-in/social", { body: { provider: "google", callbackURL: "/" } });
    record(off.status === 404, "without GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET there is no Google sign-in", `status ${off.status}`);

    const googleAuth = createAuth({
      ...cfg,
      allowedDomain: "clipwise.test",
      google: { clientId: "check-client.apps.googleusercontent.com", clientSecret: "check-placeholder" },
      ipAddressHeader: "x-test-ip",
    });
    const gapp = express();
    mountAuth(gapp, googleAuth, "x-test-ip");
    gapp.use(express.json());
    const gsrv = await listen(gapp);
    const gip = { "x-test-ip": "198.51.100.120" };
    try {
      const start = await call(gsrv.base, "POST", "/api/auth/sign-in/social", {
        body: { provider: "google", callbackURL: "/" },
        headers: gip,
      });
      const startUrl = (start.json as { url?: string } | null)?.url;
      const u = startUrl ? new URL(startUrl) : null;
      record(u?.host === "accounts.google.com", "with Google configured, sign-in starts at Google", `status ${start.status}`);
      record(u?.searchParams.get("hd") === "clipwise.test", "it asks Google for the allowed domain (hd)", `hd ${u?.searchParams.get("hd")}`);
      // One Google screen for sign-in and the calendar (SAA-198 step 5): identity
      // plus calendar.readonly, with offline access, and no forced consent.
      const scopes = (u?.searchParams.get("scope") ?? "").split(" ").sort().join(" ");
      record(scopes === `email ${CALENDAR_SCOPE} openid profile`, "it asks for identity and calendar.readonly on one screen (openid, email, profile, calendar.readonly)", `scope ${scopes}`);
      record(
        u?.searchParams.get("access_type") === "offline" && !u?.searchParams.has("prompt"),
        "it asks for offline access (a refresh token on a first grant) and forces no consent prompt",
        `access_type ${u?.searchParams.get("access_type")}, prompt ${u?.searchParams.get("prompt") ?? "(absent)"}`,
      );
      const granted = u?.searchParams.get("include_granted_scopes") ?? null;
      record(
        granted === null || granted === "false",
        "it does not ask Google to add scopes granted before (include_granted_scopes absent or false)",
        `include_granted_scopes ${granted ?? "(absent)"}`,
      );
      record(
        u?.searchParams.get("redirect_uri") === `${cfg.baseURL}/api/auth/callback/google`,
        "Google returns to /api/auth/callback/google",
        `redirect_uri ${u?.searchParams.get("redirect_uri")}`,
      );

      const gctx = await googleAuth.$context;
      const googleSource = { method: "oauth", oauth: { providerId: "google" } };
      let lastRefusal: unknown = null;
      const createdByGoogle = async (email: string): Promise<boolean> => {
        try {
          await gctx.internalAdapter.createUser({ email, name: "Google User", emailVerified: true }, googleSource);
          return true;
        } catch (err) {
          lastRefusal = err;
          return false;
        }
      };

      const outsideEmail = `outside-${tag}@outside.test`;
      await addMember({ email: outsideEmail, role: "member", name: null });
      record(
        !(await createdByGoogle(outsideEmail)) && (await userCount(outsideEmail)) === 0,
        "a Google-created user outside the allowed domain is refused at creation, even as a member",
      );
      // Better Auth's OAuth callback redirects an error to the sign-in's error
      // URL only when it carries a code (api/routes/callback.mjs:192); without
      // one the browser is left on raw JSON.
      const refusalCode = (lastRefusal as { body?: { code?: unknown } } | null)?.body?.code;
      record(
        refusalCode === "SIGN_IN_DENIED", // auth.ts's SIGN_IN_DENIED, spelled out so the control can run old code
        "the refusal carries a code, so a refused Google sign-in is sent back to /login",
        `body.code ${String(refusalCode)}`,
      );

      const nonMemberEmail = emailFor("google-nonmember");
      record(
        !(await createdByGoogle(nonMemberEmail)) && (await userCount(nonMemberEmail)) === 0,
        "a Google-created user inside the domain who is not a member is refused at creation",
      );

      const googleMemberEmail = emailFor("google-member");
      await addMember({ email: googleMemberEmail, role: "member", name: null });
      record(
        (await createdByGoogle(googleMemberEmail)) && (await userCount(googleMemberEmail)) === 1,
        "and a member inside the domain is created (the control for the two refusals)",
      );

      // Explicit linking: a signed-in password user asks to link Google.
      // Implicit linking stays off; this call is the only way a password login
      // gains Google.
      const linkEmail = emailFor("google-link");
      await addMember({ email: linkEmail, role: "member", name: null });
      await createPasswordLogin(linkEmail, "Link", PASSWORD);
      const linker = await signIn(gsrv.base, linkEmail, PASSWORD, gip);
      const link = await call(gsrv.base, "POST", "/api/auth/link-social", {
        body: { provider: "google", callbackURL: "/" },
        cookie: linker.cookie,
        headers: gip,
      });
      const linkUrl = (link.json as { url?: string } | null)?.url;
      record(
        linker.status === 200 && !!linkUrl && new URL(linkUrl).host === "accounts.google.com",
        "a signed-in password user can start linking Google",
        `sign-in ${linker.status}, link ${link.status}`,
      );
      const anon = await call(gsrv.base, "POST", "/api/auth/link-social", { body: { provider: "google", callbackURL: "/" }, headers: gip });
      record(anon.status === 401, "and linking without a session is refused", `status ${anon.status}`);

      // --- Google's tokens: calendar_connections, never auth_account --------
      // (SAA-198 step 5.) Better Auth writes a Google account's tokens through
      // internalAdapter.createAccount (a first sign-in or a link) and
      // updateAccount (a returning sign-in), with the account hooks around both
      // (oauth2/link-account.mjs), so the cases call those two with what a
      // sign-in carries. Google is stubbed as in the calendar section: only its
      // calendar list answers, with gPrimary as the primary address.
      const gEnv = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CALENDAR_TOKEN_ENCRYPTION_KEY"] as const;
      const gSaved = gEnv.map((k) => [k, process.env[k]] as const);
      process.env.GOOGLE_CLIENT_ID = "check-client.apps.googleusercontent.com";
      process.env.GOOGLE_CLIENT_SECRET = "check-placeholder";
      process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      const gRealFetch = globalThis.fetch;
      let gPrimary = "";
      // calendarList refused as Google refuses a token without a calendar scope
      // (403), and how often calendarList was asked.
      let gListRefused = false;
      let gListCalls = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) {
          gListCalls++;
          if (gListRefused) return Response.json({ error: { code: 403, message: "insufficient scopes" } }, { status: 403 });
          return Response.json({ items: [{ id: gPrimary, primary: true, accessRole: "owner" }] });
        }
        return gRealFetch(input, init);
      }) as typeof fetch;
      try {
        // An id token as Better Auth hands it on (already verified by then): only
        // its subject is read.
        const idTokenFor = (sub: string) =>
          [{ alg: "none" }, { sub, iss: "https://accounts.google.com" }, "sig"]
            .map((p) => (typeof p === "string" ? p : Buffer.from(JSON.stringify(p)).toString("base64url")))
            .join(".");
        const userIdOf = async (email: string) =>
          (await pool.query<{ id: string }>(`select id from auth_user where email = $1`, [email])).rows[0]?.id ?? null;
        const accountTokens = async (sub: string) =>
          (
            await pool.query<{ a: string | null; r: string | null; i: string | null }>(
              `select "accessToken" a, "refreshToken" r, "idToken" i from auth_account where "providerId" = 'google' and "accountId" = $1`,
              [sub],
            )
          ).rows[0] ?? null;
        const connectionOf = async (email: string) =>
          (
            await pool.query<{ refresh: string; calendar_email: string }>(
              `select c.refresh_token refresh, c.calendar_email from calendar_connections c join account_members m on m.id = c.member_id where m.email = $1`,
              [email],
            )
          ).rows;
        const { decrypt } = await import("../lib/crypto.js");
        const fullScope = `openid,email,profile,${CALENDAR_SCOPE}`;

        // A first grant: the member googleMemberEmail, created by Google above.
        const sub1 = `sub-first-${tag}`;
        gPrimary = googleMemberEmail;
        const firstUser = await userIdOf(googleMemberEmail);
        const firstAccount = await gctx.internalAdapter.createAccount({
          userId: firstUser!,
          providerId: "google",
          accountId: sub1,
          accessToken: "check-google-access-1",
          refreshToken: "check-google-refresh-1",
          idToken: idTokenFor(sub1),
          scope: fullScope,
        });
        const t1 = await accountTokens(sub1);
        record(
          !!t1 && t1.a === null && t1.r === null && t1.i === null,
          "first grant: auth_account keeps no Google token (access, refresh and id token all null)",
          `access ${t1?.a === null ? "null" : "SET"}, refresh ${t1?.r === null ? "null" : "SET"}, id ${t1?.i === null ? "null" : "SET"}`,
        );
        const c1 = await connectionOf(googleMemberEmail);
        record(
          c1.length === 1 && c1[0].calendar_email === googleMemberEmail && decrypt(c1[0].refresh) === "check-google-refresh-1" && c1[0].refresh !== "check-google-refresh-1",
          "first grant: the calendar connection is stored for the member, refresh token encrypted",
          `rows ${c1.length}`,
        );

        // A returning sign-in, Google sending no refresh token: the row stays.
        await gctx.internalAdapter.updateAccount(firstAccount.id, {
          providerId: "google",
          idToken: idTokenFor(sub1),
          accessToken: "check-google-access-2",
        });
        const t2 = await accountTokens(sub1);
        const c2 = await connectionOf(googleMemberEmail);
        record(
          !!t2 && t2.a === null && t2.i === null && c2.length === 1 && decrypt(c2[0].refresh) === "check-google-refresh-1",
          "returning sign-in, no refresh token: auth_account stays empty, and the connection is left as it is",
          `access ${t2?.a === null ? "null" : "SET"}, rows ${c2.length}`,
        );

        // A returning sign-in that Google re-asked (consent, a refresh token)
        // but whose scope Better Auth's update path does not carry: on the
        // sign-in path, a calendarList that succeeds proves the grant, and the
        // connection is stored with calendar.readonly as its scope.
        const listedBefore = gListCalls;
        await gctx.internalAdapter.updateAccount(firstAccount.id, {
          providerId: "google",
          idToken: idTokenFor(sub1),
          accessToken: "check-google-access-3",
          refreshToken: "check-google-refresh-3",
        });
        const t3 = await accountTokens(sub1);
        const c3 = await connectionOf(googleMemberEmail);
        const scope3 = (await pool.query<{ scope: string | null }>(
          `select c.scope from calendar_connections c join account_members m on m.id = c.member_id where m.email = $1`,
          [googleMemberEmail],
        )).rows[0]?.scope;
        record(
          !!t3 && t3.a === null && t3.r === null && c3.length === 1 && decrypt(c3[0].refresh) === "check-google-refresh-3"
            && scope3 === CALENDAR_SCOPE && gListCalls - listedBefore === 1,
          "returning sign-in, refresh token, no scope reported, calendarList succeeds: the connection is stored with calendar.readonly, auth_account empty",
          `refresh in row ${c3.length ? (decrypt(c3[0].refresh) === "check-google-refresh-3" ? "the new one" : "the old one") : "none"}, scope ${scope3}, calendarList asked ${gListCalls - listedBefore}`,
        );

        // The same, but Google refuses calendarList (403, no calendar scope on
        // the token): nothing stored, after calendarList was asked.
        await pool.query(`delete from calendar_connections where member_id = (select id from account_members where email = $1)`, [googleMemberEmail]);
        const listedBefore4 = gListCalls;
        gListRefused = true;
        try {
          await gctx.internalAdapter.updateAccount(firstAccount.id, {
            providerId: "google",
            idToken: idTokenFor(sub1),
            accessToken: "check-google-access-4",
            refreshToken: "check-google-refresh-4",
          });
        } finally {
          gListRefused = false;
        }
        const t3b = await accountTokens(sub1);
        const c3b = await connectionOf(googleMemberEmail);
        record(
          !!t3b && t3b.a === null && t3b.r === null && c3b.length === 0 && gListCalls - listedBefore4 === 1,
          "returning sign-in, refresh token, no scope reported, calendarList refused (403): nothing stored, auth_account empty",
          `rows ${c3b.length}, calendarList asked ${gListCalls - listedBefore4}`,
        );

        // Decision 28 on the sign-in path: Google's primary address is not the member's.
        const otherGoogleEmail = emailFor("google-other-address");
        await addMember({ email: otherGoogleEmail, role: "member", name: null });
        await createdByGoogle(otherGoogleEmail);
        const sub2 = `sub-other-${tag}`;
        gPrimary = emailFor("someone-else");
        await gctx.internalAdapter.createAccount({
          userId: (await userIdOf(otherGoogleEmail))!,
          providerId: "google",
          accountId: sub2,
          accessToken: "check-google-access-4",
          refreshToken: "check-google-refresh-4",
          idToken: idTokenFor(sub2),
          scope: fullScope,
        });
        const t4 = await accountTokens(sub2);
        const c4 = await connectionOf(otherGoogleEmail);
        const c4other = (await pool.query(`select 1 from calendar_connections where calendar_email = $1`, [gPrimary])).rowCount;
        record(
          !!t4 && t4.a === null && t4.r === null && c4.length === 0 && c4other === 0,
          "sign-in with a Google account whose primary address is not the member's (decision 28): nothing stored, auth_account empty",
          `rows for the member ${c4.length}, for the address ${c4other}`,
        );

        // clear-google-tokens: an account written before the hooks (raw SQL,
        // as hosted's identity-only sign-ins were) is counted, left alone
        // without --apply, cleared with it; a non-Google account is untouched.
        // --apply clears EVERY Google account's tokens on the database this
        // runs on, not only the fixture row (see the header); scratch-db.sh's
        // guard confines that to the scratch branch.
        const grantModule = await import("./google-calendar-grant.js").catch(() => null);
        const oldSub = `sub-old-${tag}`;
        await pool.query(
          `insert into auth_account (id, "accountId", "providerId", "userId", "accessToken", "idToken", "createdAt", "updatedAt") ` +
            `values ($1, $2, 'google', $3, 'check-old-access', 'check-old-id', now(), now()), ($4, $5, 'check-other', $3, 'check-other-access', null, now(), now())`,
          [`old-${tag}`, oldSub, firstUser, `other-${tag}`, `other-${tag}`],
        );
        let dry: { holding: number; cleared: number } | null = null;
        let applied: { holding: number; cleared: number } | null = null;
        let after: { holding: number; cleared: number } | null = null;
        try {
          dry = await grantModule!.clearGoogleTokens(false);
          const stillThere = await accountTokens(oldSub);
          applied = await grantModule!.clearGoogleTokens(true);
          after = await grantModule!.clearGoogleTokens(false);
          const cleared = await accountTokens(oldSub);
          const other = (await pool.query<{ a: string | null }>(`select "accessToken" a from auth_account where id = $1`, [`other-${tag}`])).rows[0];
          record(
            dry.holding >= 1 && dry.cleared === 0 && stillThere?.a === "check-old-access",
            "clear-google-tokens without --apply counts the old Google accounts and changes nothing",
            `holding ${dry.holding}, the old row's access ${stillThere?.a === "check-old-access" ? "still set" : "CHANGED"}`,
          );
          record(
            applied.cleared === dry.holding && after.holding === 0 && cleared?.a === null && cleared?.i === null && other?.a === "check-other-access",
            "clear-google-tokens --apply clears them all and leaves another provider's account alone",
            `cleared ${applied.cleared} of ${dry.holding}, holding after ${after.holding}, other provider's token ${other?.a === "check-other-access" ? "kept" : "CHANGED"}`,
          );
        } catch (err) {
          record(false, "clear-google-tokens without --apply counts the old Google accounts and changes nothing", `threw ${err instanceof Error ? err.message : String(err)}`);
          record(false, "clear-google-tokens --apply clears them all and leaves another provider's account alone", "not run");
        }
      } finally {
        globalThis.fetch = gRealFetch;
        for (const [k, v] of gSaved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    } finally {
      await gsrv.close();
    }

    // --- OAuth for claude.ai / Claude Code ---------------------------------
    const meta = await call(srv.base, "GET", "/api/auth/.well-known/oauth-authorization-server");
    const m = (meta.json ?? {}) as Record<string, unknown>;
    record(meta.status === 200 && typeof m.authorization_endpoint === "string" && typeof m.token_endpoint === "string", "authorization server metadata is served", `status ${meta.status}`);
    record(Array.isArray(m.code_challenge_methods_supported) && (m.code_challenge_methods_supported as string[]).includes("S256"), "it advertises PKCE S256", JSON.stringify(m.code_challenge_methods_supported));
    record(typeof m.registration_endpoint === "string", "it advertises a registration endpoint (DCR)", String(m.registration_endpoint));
    record(Array.isArray(m.grant_types_supported) && (m.grant_types_supported as string[]).includes("refresh_token"), "it supports refresh tokens", JSON.stringify(m.grant_types_supported));

    const reg = await call(srv.base, "POST", "/api/auth/oauth2/register", {
      body: {
        client_name: `check-${tag}`,
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      headers: { "x-forwarded-for": "198.51.100.90" },
    });
    const clientId = (reg.json as { client_id?: string } | null)?.client_id;
    record((reg.status === 200 || reg.status === 201) && !!clientId, "claude.ai can register itself without a session (anonymous DCR)", `status ${reg.status}`);

    // 20 per hour on the registration endpoint, anonymous by design.
    let regLimited = false;
    for (let i = 0; i < 22 && !regLimited; i++) {
      const r = await call(srv.base, "POST", "/api/auth/oauth2/register", {
        body: {
          client_name: `check-${tag}-${i}`,
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          token_endpoint_auth_method: "none",
        },
      });
      if (r.status === 429) regLimited = true;
    }
    record(regLimited, "anonymous client registration is rate limited");
  } finally {
    await srv.close();
    await cleanup();
  }
}

main()
  .catch((err) => {
    failed++;
    total++;
    process.stderr.write(`FAIL check-auth crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  })
  .finally(async () => {
    process.stdout.write(`\n${total - failed}/${total} passed\n`);
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  });
