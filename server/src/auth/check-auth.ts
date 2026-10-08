// Live check for sign-in: Better Auth mounted on an in-process Express server
// against a real database. Covers password sign-in, closed sign-up, the
// member gate, removal revoking sessions, rate limiting (including a client
// that picks its own forwarding header), anonymous client registration and the
// OAuth discovery document.
//
// WRITES to the database it is pointed at (throwaway members, users and OAuth
// clients, all tagged and removed at the end), so it refuses to run unless the
// caller says the database is a scratch one. The database must already be
// provisioned (db:provision) and have its account (auth init-account).
//
// Usage:
//   CLIPWISE_CHECK_SCRATCH_DB=1 tsx src/auth/check-auth.ts
// with DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL and
// AUTH_PASSWORD_ENABLED=true set (see .env.example).

import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { sql } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { authConfigFromEnv, createAuth, getAuth } from "./auth.js";
import { addMember, createPasswordLogin, removeMember, requireAccount, Refusal } from "./members.js";
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
  const like = `%-${tag}@clipwise.test`;
  try {
    await pool.query(`delete from auth_session where "userId" in (select id from auth_user where email like $1)`, [like]);
    await pool.query(`delete from auth_account where "userId" in (select id from auth_user where email like $1)`, [like]);
    await pool.query(`delete from auth_user where email like $1`, [like]);
    await pool.query(`delete from account_members where email like $1`, [like]);
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
