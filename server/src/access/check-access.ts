// Access check: who can see and do what, against the real app and a real
// database, with real tokens from the real OAuth flow.
//
//  1. Classification. Builds the app, lists every route on it, and fails on any
//     route that access/classification.ts does not classify (and on any entry
//     there that no longer exists).
//  2. Without a token every route that needs one answers 401, and a server with
//     no sign-in configured answers 503 instead of serving anyone.
//  3. Two members and an admin, with recordings that are private, shared,
//     shared-but-personal, trashed and carrying personnel-assessment moments.
//     Each reads, searches, lists and writes through every route; nobody sees
//     what they should not, by any route, count or error message.
//  4. Two kinds of token (SAA-244): every route takes the kind the table says
//     (`requires`) and refuses the other; only the recorder's client can obtain a
//     capture token; discovery still advertises the four MCP scopes.
//  5. Revocation: a member's still-valid token stops working on the next call
//     once they are removed.
//  6. POST /captures: the recorder's endpoint (routes/captures.ts): who it takes,
//     whose it stores, what a repeat does, and what it refuses.
//
// WRITES to the database it is pointed at (tagged rows, removed at the end), so
// it refuses to run unless told the database is a scratch one. The database
// must be provisioned and have its account.
//
// Usage:
//   CLIPWISE_CHECK_SCRATCH_DB=1 tsx src/access/check-access.ts
// with DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, AUTH_PASSWORD_ENABLED=true.
//
// Controls (SAA-244), each of which must make the check fail, and on exactly one
// line, to show the check can see what it claims to:
//   CLIPWISE_CHECK_CONTROL=requires-dropped
//       the table's `requires` for POST /accounts/:accountId/recordings is changed
//       to "mcp" in this process's copy of the table, as if the scope check had
//       been removed from that route: the line for that route fails.
//   CLIPWISE_CHECK_CONTROL=no-registration-defaults
//       the dynamic-registration assertion about the capture scope is run
//       against a provider built without clientRegistrationDefaultScopes
//       (createAuth's second argument): it fails.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { authConfigFromEnv, createAuth } from "../auth/auth.js";
import { addMember, createPasswordLogin, removeMember, requireAccount } from "../auth/members.js";
import { ensureRecorderClient, RECORDER_CLIENT_ID, RECORDER_REDIRECT_URI } from "../auth/recorder-client.js";
import { CAPTURE_SCOPE, MCP_SCOPES } from "../auth/scopes.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { db, pool, schema } from "../db/index.js";
import { encrypt } from "../lib/crypto.js";
import { resolveCalendarConnection } from "../pipeline/match-calendar.js";
import { MCP_TOOLS, ROUTES } from "./classification.js";
import { listRoutes } from "./route-list.js";

const CONTROL = process.env.CLIPWISE_CHECK_CONTROL ?? "";
if (CONTROL !== "" && CONTROL !== "requires-dropped" && CONTROL !== "no-registration-defaults") {
  process.stderr.write(`check-access: unknown CLIPWISE_CHECK_CONTROL ${JSON.stringify(CONTROL)}\n`);
  process.exit(2);
}
// The route whose `requires` the first control changes.
const CONTROL_ROUTE = "POST /accounts/:accountId/recordings";

if (process.env.CLIPWISE_CHECK_SCRATCH_DB !== "1") {
  process.stderr.write(
    "check-access: refusing to run — it writes to the database. Point DATABASE_URL at a scratch database and set CLIPWISE_CHECK_SCRATCH_DB=1.\n",
  );
  process.exit(2);
}

const tag = randomBytes(4).toString("hex");
const cfg = authConfigFromEnv();
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const WORD = `zebra${tag}`;
const KIND = `secretkind${tag}`;
// Whether this run made the recorder's client (and so removes it at the end).
let recorderCreated = false;

let failed = 0;
let total = 0;
function record(ok: boolean, name: string, detail = ""): void {
  total++;
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}\n`);
}
function sameSet(actual: Iterable<string>, expected: string[]): boolean {
  const a = [...new Set(actual)].sort();
  const e = [...expected].sort();
  return a.length === e.length && a.every((x, i) => x === e[i]);
}

let base = "";
type Reply = { status: number; json: any; headers: Headers; cookie: string };
async function http(
  method: string,
  path: string,
  o: { token?: string; json?: unknown; raw?: string; form?: Record<string, string>; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { origin: cfg.baseURL, ...o.headers };
  let body: string | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  }
  if (o.raw !== undefined) {
    headers["content-type"] = "application/json";
    body = o.raw;
  }
  if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  }
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  const res = await fetch(base + path, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, json, headers: res.headers, cookie };
}

// The real flow claude.ai and Claude Code run: register, sign in, authorize,
// consent, exchange the code. Returns an access token for the MCP resource.
let clientId = "";
type Tokens = { access: string; refresh: string | null; clientId: string };
async function tokensFor(email: string, scope = "openid offline_access"): Promise<Tokens> {
  if (!clientId) {
    const reg = await http("POST", "/api/auth/oauth2/register", {
      json: {
        client_name: `check-access-${tag}`,
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid offline_access",
      },
    });
    clientId = reg.json.client_id;
  }
  const signIn = { cookie: await sessionFor(email) };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    ...(scope ? { scope } : {}),
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: cfg.mcpResource,
  });
  const authorize = await http("GET", `/api/auth/oauth2/authorize?${query}`, { cookie: signIn.cookie });
  let codeUrl = String(authorize.json?.url ?? "");
  // First time for this person and client: the consent page. After that Better
  // Auth remembers the consent and goes straight back with a code.
  if (codeUrl.startsWith("/consent")) {
    const consent = await http("POST", "/api/auth/oauth2/consent", {
      json: { accept: true, oauth_query: codeUrl.split("?")[1] },
      cookie: signIn.cookie,
    });
    codeUrl = String(consent.json?.url ?? "");
  }
  const code = new URL(codeUrl).searchParams.get("code")!;
  const token = await http("POST", "/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      client_id: clientId,
      code_verifier: verifier,
      resource: cfg.mcpResource,
    },
  });
  return { access: token.json?.access_token as string, refresh: (token.json?.refresh_token as string) ?? null, clientId };
}
const tokenFor = async (email: string, scope?: string): Promise<string> => (await tokensFor(email, scope)).access;

// One sign-in per person for the whole run: sign-in is rate-limited (10 per
// 5 minutes, auth/auth.ts), and every flow below needs a session.
const sessions = new Map<string, string>();
async function sessionFor(email: string): Promise<string> {
  const known = sessions.get(email);
  if (known) return known;
  const signIn = await http("POST", "/api/auth/sign-in/email", { json: { email, password: PASSWORD } });
  sessions.set(email, signIn.cookie);
  return signIn.cookie;
}

// SAA-244. One authorization-code + PKCE flow for any client, scope and
// resource, reporting how far it got: the access token, or the error and the
// step that gave it. (tokensFor above is the claude.ai-shaped flow the older
// checks use; this one takes the client and resource as arguments.)
type FlowResult = { access: string | null; refresh: string | null; error: string | null; step: "authorize" | "token" | "done" };
async function oauthFlow(o: { email: string; clientId: string; redirectUri: string; scope: string; resource: string }): Promise<FlowResult> {
  const signIn = { cookie: await sessionFor(o.email) };
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: o.scope,
    state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: o.resource,
  });
  const authorize = await http("GET", `/api/auth/oauth2/authorize?${query}`, { cookie: signIn.cookie });
  let next = String(authorize.json?.url ?? authorize.headers.get("location") ?? "");
  if (next.startsWith("/consent")) {
    const consent = await http("POST", "/api/auth/oauth2/consent", {
      json: { accept: true, oauth_query: next.split("?")[1] },
      cookie: signIn.cookie,
    });
    next = String(consent.json?.url ?? consent.headers.get("location") ?? "");
  }
  const back = next ? new URL(next, cfg.baseURL) : null;
  const code = back?.searchParams.get("code") ?? null;
  const authError = back?.searchParams.get("error") ?? (authorize.json?.error as string | undefined) ?? null;
  if (!code) return { access: null, refresh: null, error: authError ?? "no_code", step: "authorize" };
  const token = await http("POST", "/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: o.redirectUri,
      client_id: o.clientId,
      code_verifier: verifier,
      resource: o.resource,
    },
  });
  if (!token.json?.access_token) return { access: null, refresh: null, error: (token.json?.error as string) ?? "no_token", step: "token" };
  return { access: token.json.access_token as string, refresh: (token.json.refresh_token as string) ?? null, error: null, step: "done" };
}

type Who = { email: string; memberId: string; token: string; refresh: string | null };
async function makeUser(label: string, role: "admin" | "member"): Promise<Who> {
  const email = `${label}-${tag}@clipwise.test`;
  const member = await addMember({ email, role, name: `Check ${label}` });
  await createPasswordLogin(email, `Check ${label}`, PASSWORD);
  const t = await tokensFor(email);
  return { email, memberId: member.id, token: t.access, refresh: t.refresh };
}

async function cleanup(accountId: string | null): Promise<void> {
  const like = `%-${tag}@clipwise.test`;
  const run = async (q: string, p: unknown[]) => {
    try {
      await pool.query(q, p);
    } catch (err) {
      process.stderr.write(`check-access: cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  if (accountId) {
    await run(`delete from recordings where account_id = $1 and slug like $2`, [accountId, `check-access-${tag}-%`]);
    // Captures made through POST /captures: slug is clipwise-capture-<stem>-<id>, and the stems start with the tag.
    await run(`delete from recordings where account_id = $1 and slug like $2`, [accountId, `clipwise-capture-check-access-${tag}-%`]);
    await run(`delete from people where account_id = $1 and email like $2`, [accountId, like]);
  }
  for (const t of ["oauthRefreshToken", "oauthAccessToken", "oauthConsent"]) {
    await run(`delete from "${t}" where "userId" in (select id from auth_user where email like $1)`, [like]);
  }
  await run(`delete from auth_session where "userId" in (select id from auth_user where email like $1)`, [like]);
  await run(`delete from auth_account where "userId" in (select id from auth_user where email like $1)`, [like]);
  await run(`delete from auth_user where email like $1`, [like]);
  await run(`delete from calendar_connections where member_id in (select id from account_members where email like $1)`, [like]);
  await run(`delete from account_members where email like $1`, [like]);
  await run(`delete from "oauthClient" where name like $1`, [`check-access-${tag}%`]);
  // The recorder's client is the instance's own; remove it only if this run made it.
  if (recorderCreated) {
    await run(`delete from "oauthClientResource" where "clientId" = $1`, [RECORDER_CLIENT_ID]);
    await run(`delete from "oauthClient" where "clientId" = $1`, [RECORDER_CLIENT_ID]);
  }
}

async function main(): Promise<void> {
  const account = await requireAccount();
  const acc = account.id;
  process.stdout.write(`account: ${account.name}; tag ${tag}\n`);

  const { app, mounts } = await buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    if (CONTROL === "requires-dropped") {
      ROUTES[CONTROL_ROUTE] = { ...ROUTES[CONTROL_ROUTE], requires: "mcp" };
      process.stdout.write(`control: requires-dropped — ${CONTROL_ROUTE} says "mcp" in this process's copy of the table\n`);
    }
    if (CONTROL === "no-registration-defaults") {
      process.stdout.write("control: no-registration-defaults — the dynamic-registration scope assertion runs against a provider without clientRegistrationDefaultScopes\n");
    }

    // ---- 1. classification -------------------------------------------------
    const listed = listRoutes(app, mounts).map((r) => `${r.method} ${r.path}`);
    const unclassified = listed.filter((k) => !ROUTES[k]);
    const stale = Object.keys(ROUTES).filter((k) => !listed.includes(k));
    record(unclassified.length === 0, `every route on the app is classified (${listed.length} routes)`, `unclassified: ${unclassified.join("; ")}`);
    record(stale.length === 0, "every classified route exists on the app", `missing: ${stale.join("; ")}`);
    record(
      Object.values(MCP_TOOLS).every((t) => t.access === "member"),
      `every MCP tool in the table is classified (${Object.keys(MCP_TOOLS).join(", ")}); the server's actual tool list is compared with it further down`,
    );

    // ---- 2. no token -------------------------------------------------------
    const fill = (p: string) => p.replace(":accountId", acc).replace(":captureId", randomUUID().toUpperCase()).replace(":id", randomUUID()).replace("/*", "/ok");
    for (const key of listed) {
      const [method, path] = key.split(" ");
      const cls = ROUTES[key]?.access;
      if (!cls || cls === "public") continue;
      const real = method === "ALL" ? "GET" : method;
      const none = await http(real, fill(path), { json: real === "POST" ? {} : undefined });
      const junk = await http(real, fill(path), { token: "junk.junk.junk", json: real === "POST" ? {} : undefined });
      record(none.status === 401 && junk.status === 401, `${key}: no token and a junk token both get 401`, `got ${none.status} / ${junk.status}`);
    }
    const health = await http("GET", "/health");
    const authOk = await http("GET", "/api/auth/ok");
    const callback = await http("GET", "/oauth/google/callback");
    record(health.status === 200 && authOk.status === 200 && callback.status === 400, "the public routes answer without a token (health 200, auth 200, callback 400 without a state)", `${health.status}/${authOk.status}/${callback.status}`);

    // The tab icon: public, static, and it must not set a cookie or carry any data.
    for (const path of ["/favicon.svg", "/favicon.ico"]) {
      const res = await fetch(base + path, { redirect: "manual" });
      const text = await res.text();
      record(
        res.status === 200 &&
          (res.headers.get("content-type") ?? "").startsWith("image/svg+xml") &&
          text.startsWith("<svg") &&
          res.headers.get("set-cookie") === null &&
          res.headers.get("x-content-type-options") === "nosniff" &&
          (res.headers.get("content-security-policy") ?? "") === "default-src 'none'",
        `${path} is public, answers an SVG with no cookie and a locked-down CSP`,
        `${res.status} ${res.headers.get("content-type")} set-cookie=${res.headers.get("set-cookie")} csp=${res.headers.get("content-security-policy")}`,
      );
    }
    const iconLoginHtml = await (await fetch(base + "/login")).text();
    record(iconLoginHtml.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'), "/login names the tab icon");

    // ---- 3. users, fixtures ------------------------------------------------
    const A = await makeUser("alice", "member");
    const B = await makeUser("bob", "member");
    const C = await makeUser("carol", "admin");

    const people = {
      hidden: (await db.insert(schema.people).values({ accountId: acc, email: `hidden-${tag}@clipwise.test`, name: `Hidden ${tag}` }).returning())[0],
      shared: (await db.insert(schema.people).values({ accountId: acc, email: `shared-${tag}@clipwise.test`, name: `Shared ${tag}` }).returning())[0],
      free: (await db.insert(schema.people).values({ accountId: acc, email: `free-${tag}@clipwise.test`, name: `Free ${tag}` }).returning())[0],
    };

    const rec: Record<string, { id: string; momentId: string; personnelId?: string }> = {};
    async function mk(
      key: string,
      o: { owner: Who; visibility: "private" | "shared"; scope?: "work" | "personal"; trashed?: boolean; personnel?: boolean; kind?: string; person?: { id: string } },
    ): Promise<void> {
      const [r] = await db
        .insert(schema.recordings)
        .values({
          accountId: acc,
          ownerMemberId: o.owner.memberId,
          visibility: o.visibility,
          scope: o.scope ?? "work",
          trashedAt: o.trashed ? new Date() : null,
          slug: `check-access-${tag}-${key}`,
          title: `${WORD} ${key}`,
          source: "check-access",
          sourceId: `${tag}-${key}`,
          startedAt: new Date(),
        })
        .returning({ id: schema.recordings.id });
      const [t] = await db.insert(schema.transcripts).values({ recordingId: r.id, provider: "check", status: "ready" }).returning({ id: schema.transcripts.id });
      await db.insert(schema.segments).values({ accountId: acc, recordingId: r.id, transcriptId: t.id, startSec: 0, endSec: 2, text: `words ${key}`, orderIndex: 0 });
      const base_ = { accountId: acc, recordingId: r.id, startSec: 0, endSec: 1, metadata: { source: "hand_curated" } };
      const [m] = await db.insert(schema.moments).values({ ...base_, kind: o.kind ?? "observation", title: `${WORD} ${key}`, summary: `about ${WORD}` }).returning({ id: schema.moments.id });
      let personnelId: string | undefined;
      if (o.personnel) {
        const [p] = await db
          .insert(schema.moments)
          .values({ ...base_, kind: "observation", title: `${WORD} ${key} personnel`, summary: `about ${WORD}`, isPersonnelAssessment: true })
          .returning({ id: schema.moments.id });
        personnelId = p.id;
      }
      if (o.person) await db.insert(schema.attendees).values({ recordingId: r.id, personId: o.person.id, name: "Guest" });
      rec[key] = { id: r.id, momentId: m.id, personnelId };
    }
    await mk("a1", { owner: A, visibility: "private", kind: KIND, person: people.hidden });
    await mk("a2", { owner: A, visibility: "shared", personnel: true, person: people.shared });
    await mk("a3", { owner: A, visibility: "shared", scope: "personal" });
    await mk("a4", { owner: A, visibility: "shared", trashed: true });
    await mk("b1", { owner: B, visibility: "private" });
    await mk("b2", { owner: B, visibility: "shared", personnel: true });

    const titles = async (who: Who, extra = "") => {
      const r = await http("GET", `/accounts/${acc}/moments?q=${WORD}&scope=all&limit=200${extra}`, { token: who.token });
      return { status: r.status, set: new Set<string>((r.json?.moments ?? []).map((m: any) => m.title.replace(`${WORD} `, ""))), body: r.json };
    };
    const indexed = async (who: Who) => {
      const r = await http("GET", `/accounts/${acc}/moments?index=true&scope=all&limit=200`, { token: who.token });
      const mine = (r.json?.recordings ?? []).filter((x: any) => String(x.title).startsWith(WORD));
      return { set: new Set<string>(mine.map((x: any) => x.title.replace(`${WORD} `, ""))), byTitle: Object.fromEntries(mine.map((x: any) => [x.title.replace(`${WORD} `, ""), x])) };
    };

    // ---- search ------------------------------------------------------------
    const sa = await titles(A);
    const sb = await titles(B);
    const sc = await titles(C);
    record(sameSet(sa.set, ["a1", "a2", "a2 personnel", "a3", "b2"]), "search: the owner sees own private, shared and personal calls and their own personnel moments, and others' shared work calls", [...sa.set].join(","));
    record(sameSet(sb.set, ["a2", "b1", "b2", "b2 personnel"]), "search: another member sees shared work calls and their own — not the owner's private call, personal call, trashed call or personnel moments", [...sb.set].join(","));
    record(sameSet(sc.set, ["a2", "b2"]), "search: an admin sees what any member would — no one's private calls, no personnel moments", [...sc.set].join(","));
    record(sb.body?.totalMatches === 4 && sc.body?.totalMatches === 2, "search: totalMatches counts only what the caller can see", `${sb.body?.totalMatches}/${sc.body?.totalMatches}`);

    // ---- index -------------------------------------------------------------
    const ia = await indexed(A);
    const ib = await indexed(B);
    const ic = await indexed(C);
    record(sameSet(ia.set, ["a1", "a2", "a3", "b2"]), "index: the owner's list", [...ia.set].join(","));
    record(sameSet(ib.set, ["a2", "b1", "b2"]), "index: another member's list leaves out private, personal and trashed calls", [...ib.set].join(","));
    record(sameSet(ic.set, ["a2", "b2"]), "index: an admin's list is the shared work calls", [...ic.set].join(","));
    record(ia.byTitle.a2?.totalMoments === 2 && ib.byTitle.a2?.totalMoments === 1, "index: moment counts leave out personnel moments the caller cannot see (2 for the owner, 1 for others)", `${ia.byTitle.a2?.totalMoments}/${ib.byTitle.a2?.totalMoments}`);

    // ---- kinds: no leak through the error list -----------------------------
    const kA = await http("GET", `/accounts/${acc}/moments?kind=${KIND}&scope=all`, { token: A.token });
    const kB = await http("GET", `/accounts/${acc}/moments?kind=${KIND}&scope=all`, { token: B.token });
    // The error echoes the kind the caller asked for (their own input); what
    // must not appear is that kind in the list of valid ones.
    const validForB: string[] = kB.json?.detail?.validKinds ?? [];
    record(kA.status === 200 && kB.status === 400 && validForB.length > 0 && !validForB.includes(KIND), "kind: a kind that exists only in someone's private call is unknown to everyone else, and is not in the list of valid kinds", `${kA.status}/${kB.status}; valid for B: ${validForB.join(",")}`);

    // ---- moment by id ------------------------------------------------------
    const mid = async (who: Who, id: string) => (await http("GET", `/accounts/${acc}/moments/${id}`, { token: who.token })).status;
    record((await mid(A, rec.a1.momentId)) === 200 && (await mid(B, rec.a1.momentId)) === 404 && (await mid(C, rec.a1.momentId)) === 404, "moment by id: a private call's moment is 404 to everyone but its owner, admin included");
    record((await mid(A, rec.a2.personnelId!)) === 200 && (await mid(B, rec.a2.personnelId!)) === 404, "moment by id: a personnel moment inside a shared call is 404 to everyone but the call's owner");
    record((await mid(B, rec.a2.momentId)) === 200, "moment by id: the shared call's ordinary moment is readable by another member");
    record((await mid(B, rec.a3.momentId)) === 404, "moment by id: a personal call is never readable by another member, shared or not");

    // ---- transcripts -------------------------------------------------------
    const tr = async (who: Who, key: string) => (await http("GET", `/recordings/${rec[key].id}/transcript`, { token: who.token })).status;
    record((await tr(A, "a1")) === 200 && (await tr(B, "a1")) === 404 && (await tr(C, "a1")) === 404, "transcript: a private call's transcript is 404 to everyone but its owner");
    record((await tr(B, "a2")) === 200 && (await tr(C, "a2")) === 200, "transcript: a shared call's transcript is readable by other members and the admin");
    record((await tr(B, "a3")) === 404 && (await tr(B, "a4")) === 404 && (await tr(A, "a4")) === 404, "transcript: a personal call is 404 to others, and a trashed call is 404 to everyone");

    // ---- recordings --------------------------------------------------------
    const listB = await http("GET", `/accounts/${acc}/recordings`, { token: B.token });
    const mineB = (listB.json?.recordings ?? []).filter((r: any) => String(r.title).startsWith(WORD)).map((r: any) => r.title.replace(`${WORD} `, ""));
    record(sameSet(mineB, ["a2", "b1", "b2"]), "recordings list: another member's list", mineB.join(","));
    record((await http("GET", `/accounts/${acc}/recordings/${rec.a1.id}`, { token: B.token })).status === 404 && (await http("GET", `/accounts/${acc}/recordings/${rec.a2.id}`, { token: B.token })).status === 200, "recordings by id: private is 404, shared is 200");
    record((await http("GET", `/accounts/${acc}/recordings/${rec.a1.id}/attendees`, { token: B.token })).status === 404, "attendees: a private call's attendee list is 404 to others");

    // ---- the recorder's tokens (SAA-244) -------------------------------------
    // The write routes take a capture token, so the "only the owner" checks below
    // use one for each person. The recorder's client is made by the same function
    // the CLI runs; its tokens are for audience …/capture with the capture scope,
    // claude.ai's and Claude Code's for …/mcp with the four scopes they have
    // always had.
    const recorder = await ensureRecorderClient();
    recorderCreated = recorder.created;
    const loopback = RECORDER_REDIRECT_URI.replace("127.0.0.1", "127.0.0.1:53127"); // any port: the library ignores it
    const recFlow = (who: Who) =>
      oauthFlow({ email: who.email, clientId: recorder.clientId, redirectUri: loopback, scope: `openid offline_access ${CAPTURE_SCOPE}`, resource: cfg.captureResource });
    const capA = await recFlow(A);
    const capB = await recFlow(B);
    const capC = await recFlow(C);
    const capToken = (who: Who): string => (who === A ? capA : who === B ? capB : capC).access ?? "";

    // ---- writes are the owner's --------------------------------------------
    const addAtt = (who: Who, key: string) => http("POST", `/accounts/${acc}/recordings/${rec[key].id}/attendees`, { token: capToken(who), json: { name: "Added" } });
    record((await addAtt(B, "a2")).status === 404 && (await addAtt(A, "a2")).status === 201, "attendees: only the owner can add one — even to a shared call");
    const addMoment = (who: Who, key: string) => http("POST", `/accounts/${acc}/moments`, { token: capToken(who), json: { recordingId: rec[key].id, kind: "observation", title: `${WORD} added`, startSec: 0, endSec: 1 } });
    record((await addMoment(B, "a2")).status === 404 && (await addMoment(A, "a2")).status === 201, "moments: only the owner can add one");

    // ---- a malformed id is "not found", not a server error ------------------
    // Postgres rejects a non-UUID compared with a uuid column (22P02), which used
    // to reach the error handler as a 500. The answer is the same 404 as for a
    // recording that is not there.
    {
      const bad = "not-a-uuid";
      // Each route answers with its own not-found code for an id that names nothing.
      const probes: Array<[string, Reply, string]> = [
        ["GET /recordings/:id/transcript", await http("GET", `/recordings/${bad}/transcript`, { token: A.token }), "recording_not_found"],
        ["GET /accounts/:accountId/recordings/:id", await http("GET", `/accounts/${acc}/recordings/${bad}`, { token: A.token }), "recording_not_found"],
        ["GET /accounts/:accountId/recordings/:id/attendees", await http("GET", `/accounts/${acc}/recordings/${bad}/attendees`, { token: A.token }), "recording_not_found"],
        ["POST /accounts/:accountId/recordings/:id/attendees", await http("POST", `/accounts/${acc}/recordings/${bad}/attendees`, { token: capToken(A), json: { name: "x" } }), "recording_not_found"],
        ["GET /accounts/:accountId/moments/:id", await http("GET", `/accounts/${acc}/moments/${bad}`, { token: A.token }), "moment_not_found"],
        ["GET /accounts/:accountId/people/:id", await http("GET", `/accounts/${acc}/people/${bad}`, { token: A.token }), "person_not_found"],
      ];
      for (const [label, r, code] of probes) {
        record(r.status === 404 && r.json?.error === code, `malformed id: ${label} is 404 ${code}`, `got ${r.status} ${r.json?.error ?? ""}`);
      }
    }

    // ---- a body that is not JSON, or too big, is the caller's error -----------
    // The parser's own errors used to fall through errorHandler as a 500. The
    // phrase stands for the words of a call: the answer must not repeat it.
    {
      const phrase = `PURPLE-ELEPHANT-${tag}`;
      const badJson = await http("POST", `/accounts/${acc}/recordings`, { token: capToken(A), raw: `{"title": "${phrase}", oops}` });
      record(
        badJson.status === 400 && badJson.json?.error === "invalid_json" && !JSON.stringify(badJson.json).includes(phrase),
        "bad JSON: a capture route answers 400 invalid_json and does not repeat the body",
        `got ${badJson.status} ${JSON.stringify(badJson.json)}`,
      );
      const tooBig = await http("POST", `/accounts/${acc}/recordings`, { token: capToken(A), raw: `{"title": "${"a".repeat(17 * 1024 * 1024)}"}` });
      record(tooBig.status === 413 && tooBig.json?.error === "payload_too_large", "an oversized body answers 413 payload_too_large", `got ${tooBig.status} ${JSON.stringify(tooBig.json)}`);
    }

    // ---- POST /captures (the recorder's endpoint) ---------------------------
    // The ids are uppercase UUIDs, as the recorder's manifest writes them. Stems
    // start with the tag so cleanup finds what this run made.
    type CapSeg = { track: "me" | "them"; startMs: number; endMs: number; text: string };
    const capSeg = (text: string, track: "me" | "them" = "me", startMs = 0, endMs = 1500): CapSeg => ({ track, startMs, endMs, text });
    const CAP_SEGS: CapSeg[] = [capSeg(`hello ${WORD}`), capSeg("hi there", "them", 1600, 3000)];
    // The shapes the recorder sends: the manifest's tracks (recorder/app/main.js
    // buildManifest and the stop-time readbacks) and the classifier's tracks
    // (pipeline/classify-capture.ts).
    const MANIFEST_TRACKS = [
      { track: "system", file: "system-x.f32le.pcm", encoding: "f32le", container: "raw", channels: 1, sample_rate: 48000, sample_rate_source: "systemtap_reported_tap_format", device_name: "Out", device_uid: "out-uid", frames: 144000, data_bytes: 576000, duration_s: 3.0 },
      { track: "mic", file: "mic-x.wav", encoding: "f32le", container: "wav", channels: 1, sample_rate: 48000, sample_rate_source: "wav_fmt_chunk_readback", device_name: "In", device_uid: "in-uid", frames: 144000, data_bytes: 576000, duration_s: 3.0 },
    ];
    const trackReport = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 3.0, gaps: [] as unknown[], note: "check" });
    const CLASS_TRACKS = { tap: trackReport("tap", "them"), mic: trackReport("mic", "me") };
    const capPayload = (o: { id?: string; stem?: string; segments?: CapSeg[]; identity?: unknown; extra?: Record<string, unknown> } = {}) => {
      const segments = o.segments ?? CAP_SEGS;
      const id = o.id ?? randomUUID().toUpperCase();
      return {
        captureId: id,
        startedAt: "2026-10-10T10:00:00.000Z",
        stem: o.stem ?? `check-access-${tag}-${id.slice(0, 8).toLowerCase()}`,
        engine: "parakeet",
        model: "check-model",
        language: "en",
        segments,
        sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: segments.reduce((n, x) => n + x.text.length, 0), countedFrom: "check-access segments" },
        classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: CLASS_TRACKS },
        capture: { tracks: MANIFEST_TRACKS, permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
        ...(o.identity ? { identity: o.identity } : {}),
        ...o.extra,
      };
    };
    const capPost = (who: Who, payload: unknown) => http("POST", "/captures", { token: capToken(who), json: payload });
    const capRows = async (id: string) =>
      (await pool.query(`select id, account_id, owner_member_id, source, source_id, title, slug, status, visibility, scope, metadata, updated_at from recordings where account_id = $1 and source_id = $2`, [acc, id])).rows;
    const capCount = async (rid: string, table: "segments" | "transcripts" | "attendees") =>
      (await pool.query(`select count(*)::int as n from ${table} where recording_id = $1`, [rid])).rows[0].n as number;
    const allRecordings = async () => (await pool.query(`select count(*)::int as n from recordings where account_id = $1`, [acc])).rows[0].n as number;
    const expectSlug = (stem: string, id: string) => `clipwise-capture-${stem}-${id.replace(/-/g, "").slice(0, 8).toLowerCase()}`;

    // 1. An MCP token is refused with 403, and nothing is written.
    {
      const p = capPayload();
      const r = await http("POST", "/captures", { token: A.token, json: p });
      record(r.status === 403 && r.json?.error === "insufficient_scope" && (await capRows(p.captureId)).length === 0, "captures 1: an MCP token gets 403 insufficient_scope and no row is written", `got ${r.status} ${r.json?.error ?? ""}`);
    }

    // 2. Another member's captureId is 409 capture_id_taken, and the row is unchanged.
    const capX = capPayload();
    const capXFirst = await capPost(A, capX);
    const rowsBefore = JSON.stringify(await capRows(capX.captureId));
    const taken = await capPost(B, capX);
    const rowsAfter = JSON.stringify(await capRows(capX.captureId));
    record(
      capXFirst.status === 201 && taken.status === 409 && taken.json?.error === "capture_id_taken" && rowsBefore === rowsAfter && (await capRows(capX.captureId)).length === 1,
      "captures 2: another member's captureId is 409 capture_id_taken, and the row is unchanged",
      `first ${capXFirst.status}; B ${taken.status} ${taken.json?.error ?? ""}; unchanged ${rowsBefore === rowsAfter}`,
    );
    const xRow = (await capRows(capX.captureId))[0];
    const xId = capXFirst.json?.recordingId as string;

    // 3. The owner and the account come from the token, not the body; the server sets the rest.
    {
      const p = capPayload({ extra: { ownerMemberId: B.memberId, owner_member_id: B.memberId, accountId: randomUUID(), account_id: randomUUID(), visibility: "shared", source: "elsewhere", sourceId: "mine", slug: "hijack", status: "ready", title: "hijack", scope: "personal" } });
      const r = await capPost(A, p);
      const row = (await capRows(p.captureId))[0];
      record(
        r.status === 201 && row?.owner_member_id === A.memberId && row.account_id === acc && row.source === "clipwise-recorder" && row.source_id === p.captureId && row.visibility === "private" && row.status === "pending" && String(row.title).startsWith("Clipwise capture") && row.slug === expectSlug(p.stem, p.captureId) && row.scope === null,
        "captures 3: the owner and account come from the token; source, title, slug, status and visibility are the server's, whatever the body says; an uppercase captureId is stored as sent",
        `${r.status}; owner ${row?.owner_member_id === A.memberId ? "A" : row?.owner_member_id}; ${row?.source}/${row?.source_id}; ${row?.visibility}/${row?.status}; ${row?.slug}`,
      );
    }

    // 4. The same content again is 200 created:false, with nothing new written.
    {
      const r = await capPost(A, capX);
      record(
        r.status === 200 && r.json?.created === false && r.json?.recordingId === xId && (await capRows(capX.captureId)).length === 1 && (await capCount(xId, "segments")) === 2 && (await capCount(xId, "transcripts")) === 1,
        "captures 4: the same content again is 200 created:false, with the same recording and nothing new written",
        `${r.status} ${JSON.stringify(r.json)}`,
      );
    }

    // 5. A concurrent double POST makes one row.
    {
      const p = capPayload();
      const [r1, r2] = await Promise.all([capPost(A, p), capPost(A, p)]);
      const statuses = [r1.status, r2.status].sort();
      const rows = await capRows(p.captureId);
      record(
        statuses.join() === "200,201" && rows.length === 1 && (await capCount(rows[0].id, "transcripts")) === 1 && (await capCount(rows[0].id, "segments")) === 2,
        "captures 5: a concurrent double POST makes one recording (one 201, one 200), one transcript, two segments",
        `statuses ${statuses.join()}; rows ${rows.length}`,
      );
    }

    // 6. Different segments under the same captureId are 409 capture_content_conflict, and nothing changes.
    {
      const before = JSON.stringify(await capRows(capX.captureId));
      const r = await capPost(A, capPayload({ id: capX.captureId, stem: capX.stem, segments: [capSeg("something else entirely")] }));
      record(
        r.status === 409 && r.json?.error === "capture_content_conflict" && JSON.stringify(await capRows(capX.captureId)) === before && (await capCount(xId, "segments")) === 2,
        "captures 6: different segments under the same captureId are 409 capture_content_conflict, and the row and its segments are unchanged",
        `${r.status} ${r.json?.error ?? ""}`,
      );
    }

    // 7. A later identity answer is applied once.
    {
      const answer = { identity_version: 2, answered_at: "2026-10-10T10:05:00.000Z", self: { name: `Alice ${tag}` }, guests: [{ name: `Guest ${tag}` }], scope: "personal" };
      const p = capPayload();
      const first = await capPost(A, p);
      const rid = first.json?.recordingId as string;
      const late = await capPost(A, { ...p, identity: answer });
      const atts = (await pool.query(`select name, is_host from attendees where recording_id = $1 order by is_host desc, name`, [rid])).rows;
      const stored = (await capRows(p.captureId))[0];
      const again = await capPost(A, { ...p, identity: answer });
      record(
        first.status === 201 && late.status === 200 && late.json?.created === false && late.json?.identityApplied === true && atts.length === 2 && atts[0].is_host === true && stored.scope === "personal" && stored.metadata?.identity?.answered_at === answer.answered_at,
        "captures 7a: an identity answer that arrives on a repeat is applied (host and guest attendee rows, scope, stored answer)",
        `${late.status} ${JSON.stringify(late.json)}; attendees ${atts.length}; scope ${stored.scope}`,
      );
      record(
        again.status === 200 && again.json?.identityApplied === false && (await capCount(rid, "attendees")) === 2,
        "captures 7b: the same answer again is not applied again (still two attendee rows)",
        `${again.status} ${JSON.stringify(again.json)}; attendees ${await capCount(rid, "attendees")}`,
      );
      // Two requests carrying the answer at the same moment: applied by one of them.
      const p2 = capPayload();
      const first2 = await capPost(A, p2);
      const answer2 = { ...answer, answered_at: "2026-10-10T10:06:00.000Z" };
      const [c1, c2] = await Promise.all([capPost(A, { ...p2, identity: answer2 }), capPost(A, { ...p2, identity: answer2 })]);
      const appliedCount = [c1, c2].filter((c) => c.json?.identityApplied === true).length;
      record(
        first2.status === 201 && c1.status === 200 && c2.status === 200 && appliedCount === 1 && (await capCount(first2.json?.recordingId, "attendees")) === 2,
        "captures 7c: two requests carrying the same late answer at once apply it once (one says applied, two attendee rows)",
        `${c1.status}/${c2.status}; applied by ${appliedCount}; attendees ${await capCount(first2.json?.recordingId, "attendees")}`,
      );
    }

    // 8. Two members starting in the same second: two recordings, two 201s.
    {
      const stem = `check-access-${tag}-same-second`;
      const pA = capPayload({ stem });
      const pB = capPayload({ stem });
      const [rA, rB] = await Promise.all([capPost(A, pA), capPost(B, pB)]);
      record(
        rA.status === 201 && rB.status === 201 && rA.json?.slug !== rB.json?.slug && rA.json?.slug === expectSlug(stem, pA.captureId) && rB.json?.slug === expectSlug(stem, pB.captureId),
        "captures 8: two members with the same stem and start time get two 201s and two different slugs",
        `${rA.status}/${rB.status}; ${rA.json?.slug ?? rA.json?.error} / ${rB.json?.slug ?? rB.json?.error}`,
      );
    }

    // 9. A fidelity mismatch is 422 and nothing is written.
    {
      const p = capPayload();
      const r = await capPost(A, { ...p, sourceFidelity: { ...p.sourceFidelity, declaredBodyChars: p.sourceFidelity.declaredBodyChars + 1 } });
      record(r.status === 422 && r.json?.error === "transcript_fidelity_mismatch" && (await capRows(p.captureId)).length === 0, "captures 9: a fidelity mismatch is 422 transcript_fidelity_mismatch and nothing is written", `${r.status} ${r.json?.error ?? ""}`);
    }

    // 10. A body that is not JSON is 400.
    {
      const phrase = `PURPLE-CAPTURE-${tag}`;
      const r = await http("POST", "/captures", { token: capToken(A), raw: `{"stem": "${phrase}", oops}` });
      record(r.status === 400 && r.json?.error === "invalid_json" && !JSON.stringify(r.json).includes(phrase), "captures 10: bad JSON is 400 invalid_json and does not repeat the body", `${r.status} ${JSON.stringify(r.json)}`);
    }

    // 11. A GET with an id that is not a recording's is 404, not an error.
    {
      const probes: Array<[string, Reply]> = [
        ["GET /accounts/:accountId/recordings/not-a-uuid", await http("GET", `/accounts/${acc}/recordings/not-a-uuid`, { token: A.token })],
        ["GET /recordings/not-a-uuid/transcript", await http("GET", `/recordings/not-a-uuid/transcript`, { token: A.token })],
        ["GET /recordings/<the uppercase captureId>/transcript", await http("GET", `/recordings/${capX.captureId}/transcript`, { token: A.token })],
      ];
      record(probes.every(([, r]) => r.status === 404 && r.json?.error === "recording_not_found"), "captures 11: a non-UUID id, and a captureId (a UUID, but not a recording's id), are 404 recording_not_found on GET", probes.map(([l, r]) => `${l}: ${r.status}`).join("; "));
    }

    // 12. The owner reads the capture back; another member gets 404.
    {
      const own = await http("GET", `/accounts/${acc}/recordings/${xId}`, { token: A.token });
      const ownTr = await http("GET", `/recordings/${xId}/transcript`, { token: A.token });
      const otherRec = await http("GET", `/accounts/${acc}/recordings/${xId}`, { token: B.token });
      const otherTr = await http("GET", `/recordings/${xId}/transcript`, { token: B.token });
      record(
        own.status === 200 && own.json?.recording?.slug === xRow.slug && ownTr.status === 200 && JSON.stringify(ownTr.json).includes(`hello ${WORD}`) && otherRec.status === 404 && otherTr.status === 404,
        "captures 12: the owner reads the capture and its transcript back; another member gets 404 on both",
        `owner ${own.status}/${ownTr.status}; other ${otherRec.status}/${otherTr.status}`,
      );
    }

    // 14. The table loop's empty body is a 400, and nothing is written.
    {
      const nBefore = await allRecordings();
      const r = await capPost(A, {});
      record(r.status === 400 && r.json?.error === "invalid_request" && (await allRecordings()) === nBefore, "captures 14: an empty body {} is 400 invalid_request and no recording is written", `${r.status} ${r.json?.error ?? ""}`);
    }

    // 15. capture.tracks and classification.tracks of any other shape are 400, and nothing is stored.
    {
      const nBefore = await allRecordings();
      const wrong: Array<[string, (p: ReturnType<typeof capPayload>) => unknown]> = [
        ["capture.tracks as an object keyed tap and mic (not an array)", (p) => ({ ...p, capture: { ...p.capture, tracks: { tap: { verdict: "ok" }, mic: { verdict: "ok" } } } })],
        ["capture.tracks with a duration_s that is a string", (p) => ({ ...p, capture: { ...p.capture, tracks: [{ ...MANIFEST_TRACKS[0], duration_s: "3.0" }, MANIFEST_TRACKS[1]] } })],
        ["capture.tracks with a track name that is neither system nor mic", (p) => ({ ...p, capture: { ...p.capture, tracks: [{ ...MANIFEST_TRACKS[0], track: "tap" }] } })],
        ["capture.tracks as a string", (p) => ({ ...p, capture: { ...p.capture, tracks: "tracks" } })],
        ["capture.tracks as null", (p) => ({ ...p, capture: { ...p.capture, tracks: null } })],
        ["capture.tracks with a scalar in the array", (p) => ({ ...p, capture: { ...p.capture, tracks: [MANIFEST_TRACKS[0], 7] } })],
        ["classification.tracks without the mic report", (p) => ({ ...p, classification: { ...p.classification, tracks: { tap: CLASS_TRACKS.tap } } })],
        ["classification.tracks with a verdict the classifier never gives", (p) => ({ ...p, classification: { ...p.classification, tracks: { tap: { ...CLASS_TRACKS.tap, verdict: "fine" }, mic: CLASS_TRACKS.mic } } })],
        ["classification.tracks as an array", (p) => ({ ...p, classification: { ...p.classification, tracks: [CLASS_TRACKS.tap, CLASS_TRACKS.mic] } })],
      ];
      const results: string[] = [];
      let allRefused = true;
      for (const [name, build] of wrong) {
        const p = capPayload();
        const r = await capPost(A, build(p));
        const written = (await capRows(p.captureId)).length;
        const ok = r.status === 400 && r.json?.error === "invalid_request" && written === 0;
        if (!ok) allRefused = false;
        results.push(`${ok ? "ok" : "BAD"} ${name}: ${r.status} ${r.json?.error ?? ""} rows=${written}`);
      }
      record(allRefused && (await allRecordings()) === nBefore, "captures 15: capture.tracks and classification.tracks of any other shape are 400 invalid_request and nothing is written", results.filter((l) => l.startsWith("BAD")).join("; "));
      // The right shapes still go in, with fields the server does not know kept as sent.
      const p = capPayload();
      const extraTrack = { ...MANIFEST_TRACKS[1], requested_sample_rate: 44100, device_source: "miccap_resolved_default_input" };
      const ok = await capPost(A, { ...p, capture: { ...p.capture, tracks: [MANIFEST_TRACKS[0], extraTrack] } });
      const stored = (await capRows(p.captureId))[0];
      record(
        ok.status === 201 && stored?.metadata?.capture?.tracks?.[1]?.requested_sample_rate === 44100 && stored?.metadata?.capture?.tracks?.[1]?.duration_s === 3.0 && stored?.metadata?.capture_quality?.tracks?.tap?.verdict === "live",
        "captures 15: the recorder's shapes are accepted, a track's extra fields are kept as sent, and both are stored on the row",
        `${ok.status} ${ok.json?.error ?? ""}`,
      );
    }

    // 16. Voice data (SAA-227 decision 1): each them segment's voice index and each
    // voice's total seconds are taken; an embedding, on a voice or on a segment, is
    // refused and nothing is written, as is a voice index that is not one of the
    // listed voices or sits on a me segment.
    const VOICE_SEGS: CapSeg[] = [capSeg(`hello ${WORD}`), capSeg("first voice", "them", 1600, 3000), capSeg("second voice", "them", 3100, 4500)];
    const withVoices = (segs: Array<CapSeg & { voiceIndex?: number; embedding?: number[] }>, voices: unknown[]) => {
      const p = capPayload({ segments: segs.map(({ track, startMs, endMs, text }) => ({ track, startMs, endMs, text })), extra: { voices } });
      return { ...p, segments: segs };
    };
    {
      const p = withVoices(
        [VOICE_SEGS[0], { ...VOICE_SEGS[1], voiceIndex: 1 }, { ...VOICE_SEGS[2], voiceIndex: 2 }],
        [{ voiceIndex: 1, totalSeconds: 41.5 }, { voiceIndex: 2, totalSeconds: 18 }],
      );
      const r = await capPost(A, p);
      const rows = await capRows(p.captureId);
      record(
        r.status === 201 && rows.length === 1 && (await capCount(rows[0].id, "segments")) === 3,
        "captures 16a: voice indexes on them segments and each voice's total seconds are taken; the capture is stored with its segments",
        `${r.status} ${r.json?.error ?? ""} rows=${rows.length}`,
      );
    }
    {
      const nBefore = await allRecordings();
      const voicesOk = [{ voiceIndex: 1, totalSeconds: 41.5 }];
      const cases: Array<[string, ReturnType<typeof withVoices>]> = [
        ["an embedding on a voice", withVoices([VOICE_SEGS[0], { ...VOICE_SEGS[1], voiceIndex: 1 }], [{ voiceIndex: 1, totalSeconds: 41.5, embedding: [0.12, -0.5, 0.33] }])],
        ["an embedding on a segment", withVoices([VOICE_SEGS[0], { ...VOICE_SEGS[1], voiceIndex: 1, embedding: [0.12, -0.5, 0.33] }], voicesOk)],
        ["a voice index on a me segment", withVoices([{ ...VOICE_SEGS[0], voiceIndex: 1 }, VOICE_SEGS[1]], voicesOk)],
        ["a voice index that is not a listed voice", withVoices([VOICE_SEGS[0], { ...VOICE_SEGS[1], voiceIndex: 2 }], voicesOk)],
      ];
      const results: string[] = [];
      for (const [label, p] of cases) {
        const r = await capPost(A, p);
        const written = (await capRows(p.captureId)).length;
        results.push(`${r.status === 400 && r.json?.error === "invalid_request" && written === 0 ? "ok" : "BAD"} ${label}: ${r.status} ${r.json?.error ?? ""} rows=${written}`);
      }
      record(
        results.every((l) => l.startsWith("ok")) && (await allRecordings()) === nBefore,
        "captures 16b: an embedding on a voice or a segment, a voice index on a me segment, and an unlisted voice index are each 400 invalid_request, and nothing is written",
        results.filter((l) => l.startsWith("BAD")).join("; "),
      );
    }

    // 17. Voice names and repeats (SAA-227 decisions 3 and 5).
    const splitPayload = () =>
      withVoices([VOICE_SEGS[0], { ...VOICE_SEGS[1], voiceIndex: 1 }, { ...VOICE_SEGS[2], voiceIndex: 2 }], [{ voiceIndex: 1, totalSeconds: 41.5 }, { voiceIndex: 2, totalSeconds: 18 }]);
    const voiceNamesDoc = (at: string, voices: Array<{ voiceIndex: number; name: string | null }>, rename = false) => ({ voice_names_version: 1, answered_at: at, voices, ...(rename ? { rename: true } : {}) });
    const speakerNames = async (rid: string) =>
      Object.fromEntries((await pool.query(`select label, display_name from speakers where recording_id = $1`, [rid])).rows.map((r) => [r.label, r.display_name]));
    const reextracts = async (rid: string) => (await pool.query(`select count(*)::int as n from jobs where recording_id = $1 and kind = 're_extract'`, [rid])).rows[0].n as number;
    // As if the worker had finished the first extraction: a late name then needs a re-extract.
    const markExtracted = async (rid: string) => {
      await pool.query(`update jobs set state = 'done' where recording_id = $1`, [rid]);
      await pool.query(`update recordings set status = 'ready', metadata = metadata || jsonb_build_object('current_extraction_run', gen_random_uuid()::text) where id = $1`, [rid]);
    };

    // 17a. A first POST carrying voices and voice names stores the names on the Voice rows.
    {
      const p = { ...splitPayload(), voiceNames: voiceNamesDoc("2026-10-11T11:00:00.000Z", [{ voiceIndex: 1, name: `Vee ${tag}` }, { voiceIndex: 2, name: `Wes ${tag}` }]) };
      const r = await capPost(A, p);
      const names = r.status === 201 ? await speakerNames(r.json.recordingId) : {};
      record(
        r.status === 201 && names["Voice 1"] === `Vee ${tag}` && names["Voice 2"] === `Wes ${tag}` && !("them" in names),
        "captures 17a: a first POST carrying voices and voice names stores the names on the Voice rows",
        `${r.status} ${r.json?.error ?? ""} ${JSON.stringify(Object.keys(names))}`,
      );
    }

    // 17b. Names on a repeat are applied once and queue one re-extract.
    // 17c. Changed names follow apply-voice-names' rules: an already-named voice is
    //      skipped without rename (nothing written, no re-extract); a rename overwrites,
    //      and a rename to "Not sure" clears.
    {
      const p = splitPayload();
      const first = await capPost(A, p);
      const rid = first.json?.recordingId as string;
      await markExtracted(rid);
      const answer = voiceNamesDoc("2026-10-11T11:10:00.000Z", [{ voiceIndex: 1, name: `Vee ${tag}` }, { voiceIndex: 2, name: null }]);
      const late = await capPost(A, { ...p, voiceNames: answer });
      const afterLate = await speakerNames(rid);
      const jobsAfterLate = await reextracts(rid);
      const again = await capPost(A, { ...p, voiceNames: answer });
      record(
        first.status === 201 && late.status === 200 && late.json?.voiceNamesApplied === true && afterLate["Voice 1"] === `Vee ${tag}` && afterLate["Voice 2"] === null && jobsAfterLate === 1 &&
          again.status === 200 && again.json?.voiceNamesApplied === false && (await reextracts(rid)) === 1 && JSON.stringify(await speakerNames(rid)) === JSON.stringify(afterLate),
        "captures 17b: voice names on a repeat are applied and queue one re-extract; the same answer again is not applied again and queues nothing",
        `${first.status}/${late.status}/${again.status} applied=${late.json?.voiceNamesApplied}/${again.json?.voiceNamesApplied} jobs=${jobsAfterLate} names=${JSON.stringify(afterLate)}`,
      );

      await pool.query(`update jobs set state = 'done' where recording_id = $1`, [rid]);
      const noRename = await capPost(A, { ...p, voiceNames: voiceNamesDoc("2026-10-11T11:20:00.000Z", [{ voiceIndex: 1, name: `Other ${tag}` }]) });
      const afterNoRename = await speakerNames(rid);
      const jobsAfterNoRename = await reextracts(rid);
      const rename = await capPost(A, { ...p, voiceNames: voiceNamesDoc("2026-10-11T11:30:00.000Z", [{ voiceIndex: 1, name: null }, { voiceIndex: 2, name: `Wes ${tag}` }], true) });
      const afterRename = await speakerNames(rid);
      record(
        noRename.status === 200 && afterNoRename["Voice 1"] === `Vee ${tag}` && jobsAfterNoRename === 1 &&
          rename.status === 200 && rename.json?.voiceNamesApplied === true && afterRename["Voice 1"] === null && afterRename["Voice 2"] === `Wes ${tag}` && (await reextracts(rid)) === 2,
        "captures 17c: a different name for a named voice is skipped without rename (no re-extract); a rename clears one voice and names another, and queues a re-extract",
        `noRename=${noRename.status} ${JSON.stringify(afterNoRename)} jobs=${jobsAfterNoRename}; rename=${rename.status} ${JSON.stringify(afterRename)} jobs=${await reextracts(rid)}`,
      );
    }

    // 17d. The same segments with different voice data: 200 and nothing written.
    {
      const p = splitPayload();
      const first = await capPost(A, p);
      const rid = first.json?.recordingId as string;
      const snapshot = async () =>
        JSON.stringify([
          (await pool.query(`select id, label, display_name from speakers where recording_id = $1 order by id`, [rid])).rows,
          (await pool.query(`select id, speaker_id from segments where recording_id = $1 order by id`, [rid])).rows,
          await capRows(p.captureId),
          (await pool.query(`select id, kind, state from jobs where recording_id = $1 order by id`, [rid])).rows,
        ]);
      const before = await snapshot();
      const other = withVoices(
        [VOICE_SEGS[0], { ...VOICE_SEGS[1], voiceIndex: 3 }, { ...VOICE_SEGS[2], voiceIndex: 3 }],
        [{ voiceIndex: 1, totalSeconds: 4 }, { voiceIndex: 2, totalSeconds: 5 }, { voiceIndex: 3, totalSeconds: 60 }],
      );
      const r = await capPost(A, { ...other, captureId: p.captureId, stem: p.stem });
      record(
        first.status === 201 && r.status === 200 && r.json?.created === false && (await snapshot()) === before,
        "captures 17d: the same segments with different voice data are 200 created:false, and no speaker, segment, recording or job row changes",
        `${first.status}/${r.status} ${r.json?.error ?? ""} unchanged=${(await snapshot()) === before}`,
      );
    }

    // 17e. A late identity answer naming one guest merges the Voice rows back into `them`.
    {
      const p = splitPayload();
      const first = await capPost(A, p);
      const rid = first.json?.recordingId as string;
      const before = await speakerNames(rid);
      const late = await capPost(A, { ...p, identity: { answered_at: "2026-10-11T11:40:00.000Z", self: { name: `Host ${tag}` }, guests: [{ name: `Guest ${tag}` }], scope: "work" } });
      const after = await speakerNames(rid);
      const segLabels = (await pool.query(`select sp.label from segments s left join speakers sp on sp.id = s.speaker_id where s.recording_id = $1 order by s.order_index`, [rid])).rows.map((x) => x.label);
      record(
        "Voice 1" in before && late.status === 200 && late.json?.identityApplied === true && JSON.stringify(Object.keys(after).sort()) === JSON.stringify(["me", "them"]) && after.them === `Guest ${tag}` && JSON.stringify(segLabels) === JSON.stringify(["me", "them", "them"]),
        "captures 17e: a late identity answer naming one guest merges the Voice rows back into a named `them`, with every them segment on it",
        `${late.status} before=${JSON.stringify(Object.keys(before))} after=${JSON.stringify(after)} segs=${segLabels.join(",")}`,
      );
    }

    // ---- the recorder's own captures (SAA-227, 10-11) ------------------------
    // 18. The owner's capture token reads the transcript and the jobs, trashes,
    // restores and deletes permanently (only from the trash). Another member's
    // capture token gets 404 capture_not_found on every one, and nothing changes.
    const trashedAtOf = async (id: string) => (await pool.query(`select trashed_at from recordings where account_id = $1 and source_id = $2`, [acc, id])).rows[0]?.trashed_at ?? null;
    {
      const p = capPayload();
      const first = await capPost(A, p);
      const rid = first.json?.recordingId as string;
      const own = (method: string, suffix: string, json?: unknown) => http(method, `/captures/${p.captureId}${suffix}`, { token: capToken(A), json });
      const other = (method: string, suffix: string, json?: unknown) => http(method, `/captures/${p.captureId}${suffix}`, { token: capToken(B), json });

      const notFound = (r: Reply) => r.status === 404 && r.json?.error === "capture_not_found";
      const before = JSON.stringify(await capRows(p.captureId));
      const theirs: Array<[string, Reply]> = [
        ["GET transcript", await other("GET", "/transcript")],
        ["GET jobs", await other("GET", "/jobs")],
        ["POST trash", await other("POST", "/trash", {})],
        ["POST restore", await other("POST", "/restore", {})],
        ["DELETE", await other("DELETE", "")],
      ];
      record(
        first.status === 201 && theirs.every(([, r]) => notFound(r)) && JSON.stringify(await capRows(p.captureId)) === before,
        "captures 18a: another member's capture token gets 404 capture_not_found on the transcript, jobs, trash, restore and delete of someone else's capture, and the row is unchanged",
        theirs.map(([l, r]) => `${l}: ${r.status} ${r.json?.error ?? ""}`).join("; "),
      );
      const malformed = await http("GET", "/captures/not-a-uuid/transcript", { token: capToken(A) });
      const absent = await http("GET", `/captures/${randomUUID().toUpperCase()}/jobs`, { token: capToken(A) });
      const badZone = await http("GET", `/captures/${p.captureId}/transcript?tz=Not/AZone`, { token: capToken(A) });
      record(
        notFound(malformed) && notFound(absent) && badZone.status === 400 && badZone.json?.error === "invalid_time_zone",
        "captures 18b: a malformed captureId and one that is not there are the same 404 capture_not_found; a time zone Intl does not know is 400 invalid_time_zone",
        `${malformed.status}/${absent.status}/${badZone.status} ${badZone.json?.error ?? ""}`,
      );

      const transcript = await own("GET", "/transcript");
      const jobs = await own("GET", "/jobs");
      record(
        transcript.status === 200 && transcript.json?.lines === 2 && String(transcript.json?.text).includes(WORD) && String(transcript.json?.suggestedFileName).endsWith("transcript.txt") &&
          jobs.status === 200 && JSON.stringify(jobs.json?.jobs) === JSON.stringify([{ kind: "extract", state: "queued", attempts: 0 }]),
        "captures 18c: the owner reads the transcript file (two lines, the suggested name) and the capture's jobs (kind, state, attempts)",
        `${transcript.status} lines=${transcript.json?.lines}; jobs ${jobs.status} ${JSON.stringify(jobs.json)}`,
      );

      // The capture started 2026-10-10T10:00Z: in Kiritimati (UTC+14) that is
      // October 11, in Pago Pago (UTC-11) October 9. Written out by hand.
      const east = await own("GET", `/transcript?tz=${encodeURIComponent("Pacific/Kiritimati")}`);
      const west = await own("GET", `/transcript?tz=${encodeURIComponent("Pacific/Pago_Pago")}`);
      const headerOf = (r: Reply) => String(r.json?.text ?? "").split("\n")[1] ?? "";
      record(
        east.status === 200 && west.status === 200 &&
          headerOf(east).startsWith("October 11, 2026 · ") && String(east.json?.suggestedFileName).startsWith("2026-10-11 ") &&
          headerOf(west).startsWith("October 9, 2026 · ") && String(west.json?.suggestedFileName).startsWith("2026-10-09 ") &&
          headerOf(east) !== headerOf(west) && east.json?.suggestedFileName !== west.json?.suggestedFileName,
        "captures 18c2: ?tz= dates the file in that zone: Pacific/Kiritimati gives October 11 (2026-10-11 …), Pacific/Pago_Pago October 9 (2026-10-09 …), for the same capture",
        `east ${east.status} "${headerOf(east)}" ${east.json?.suggestedFileName}; west ${west.status} "${headerOf(west)}" ${west.json?.suggestedFileName}`,
      );

      const notTrashed = await own("DELETE", "");
      const stillThere = (await capRows(p.captureId)).length;
      const trash = await own("POST", "/trash", { trashedAt: "2026-10-11T12:00:00.000Z" });
      const whileTrashed = await own("GET", "/transcript");
      const trashedAt = await trashedAtOf(p.captureId);
      const restore = await own("POST", "/restore", {});
      const restoredAt = await trashedAtOf(p.captureId);
      record(
        notTrashed.status === 409 && notTrashed.json?.error === "capture_not_trashed" && stillThere === 1 &&
          trash.status === 200 && trashedAt instanceof Date && trashedAt.toISOString() === "2026-10-11T12:00:00.000Z" && notFound(whileTrashed) &&
          restore.status === 200 && restoredAt === null,
        "captures 18d: delete outside the trash is 409 capture_not_trashed; trash sets trashed_at to the time sent and hides the transcript; restore clears it",
        `delete ${notTrashed.status}, trash ${trash.status} at ${trashedAt instanceof Date ? trashedAt.toISOString() : trashedAt}, transcript while trashed ${whileTrashed.status}, restore ${restore.status} -> ${restoredAt}`,
      );

      await own("POST", "/trash", {});
      const del = await own("DELETE", "");
      const left = (await capRows(p.captureId)).length;
      const jobsLeft = (await pool.query(`select count(*)::int as n from jobs where recording_id = $1`, [rid])).rows[0].n;
      const again = await own("DELETE", "");
      record(
        del.status === 200 && left === 0 && jobsLeft === 0 && notFound(again),
        "captures 18e: from the trash, delete removes the recording and its jobs; a second delete is 404",
        `${del.status} rows=${left} jobs=${jobsLeft} again=${again.status}`,
      );
    }

    // ---- the recording-notice acknowledgement (SAA-227 part I) ---------------
    // 19. A capture's notice stamp is stored on the recording, and the member's
    // acknowledgement of that version is recorded once.
    {
      const acks = async (memberId: string) =>
        (await pool.query(`select notice_version, acknowledged_at from notice_acknowledgements where member_id = $1 order by notice_version`, [memberId])).rows as Array<{ notice_version: number; acknowledged_at: Date }>;
      const stampOf = async (captureId: string) => (await capRows(captureId))[0]?.metadata?.notice;
      const v1 = { version: 1, acknowledgedAt: "2026-10-07T21:18:52.000Z" };

      const pa = capPayload({ extra: { notice: v1 } });
      const ra = await capPost(A, pa);
      const afterA = await acks(A.memberId);
      record(
        ra.status === 201 && JSON.stringify(await stampOf(pa.captureId)) === JSON.stringify({ version: 1, acknowledged_at: v1.acknowledgedAt }) &&
          afterA.length === 1 && afterA[0].notice_version === 1 && afterA[0].acknowledged_at.toISOString() === v1.acknowledgedAt &&
          (await acks(B.memberId)).length === 0,
        "captures 19a: a stamped capture stores the stamp on the recording and one acknowledgement row for its member (none for anyone else)",
        `${ra.status} ${ra.json?.error ?? ""} stamp=${JSON.stringify(await stampOf(pa.captureId))} rows=${JSON.stringify(afterA)}`,
      );

      const pb = capPayload({ extra: { notice: { version: 1, acknowledgedAt: "2026-10-11T09:00:00.000Z" } } });
      const rb = await capPost(A, pb);
      const afterB = await acks(A.memberId);
      record(
        rb.status === 201 && afterB.length === 1 && afterB[0].acknowledged_at.toISOString() === v1.acknowledgedAt,
        "captures 19b: a second capture with the same version adds no row, and the first acknowledged_at stands",
        `${rb.status} rows=${JSON.stringify(afterB)}`,
      );

      const pc = capPayload({ extra: { notice: { version: 2, acknowledgedAt: "2026-10-11T10:00:00.000Z" } } });
      const rc = await capPost(A, pc);
      const afterC = await acks(A.memberId);
      record(
        rc.status === 201 && JSON.stringify(afterC.map((r) => r.notice_version)) === JSON.stringify([1, 2]),
        "captures 19c: a new notice version adds a second row; the first is kept",
        `${rc.status} versions=${afterC.map((r) => r.notice_version).join(",")}`,
      );

      const pd = capPayload();
      const rd = await capPost(A, pd);
      record(
        rd.status === 201 && (await stampOf(pd.captureId)) === null && (await acks(A.memberId)).length === 2,
        "captures 19d: a capture with no stamp is stored with none, and adds no acknowledgement",
        `${rd.status} stamp=${JSON.stringify(await stampOf(pd.captureId))} rows=${(await acks(A.memberId)).length}`,
      );

      // A repeat of 19d's capture now carrying a stamp of a version not yet recorded.
      const before = JSON.stringify([await capRows(pd.captureId), await acks(A.memberId)]);
      const re = await capPost(A, { ...pd, notice: { version: 3, acknowledgedAt: "2026-10-11T11:00:00.000Z" } });
      record(
        re.status === 200 && re.json?.created === false && JSON.stringify([await capRows(pd.captureId), await acks(A.memberId)]) === before,
        "captures 19e: a same-content repeat carrying a stamp writes nothing: the recording keeps no stamp and no acknowledgement row is added",
        `${re.status} unchanged=${JSON.stringify([await capRows(pd.captureId), await acks(A.memberId)]) === before}`,
      );

      const nBefore = await allRecordings();
      const malformed: Array<[string, unknown]> = [
        ["version 0", { version: 0, acknowledgedAt: v1.acknowledgedAt }],
        ["version as a string", { version: "1", acknowledgedAt: v1.acknowledgedAt }],
        ["acknowledgedAt not a time", { version: 1, acknowledgedAt: "yesterday" }],
        ["no acknowledgedAt", { version: 1 }],
        ["an extra key", { version: 1, acknowledgedAt: v1.acknowledgedAt, text: "the notice" }],
      ];
      const results: string[] = [];
      for (const [label, notice] of malformed) {
        const p = capPayload({ extra: { notice } });
        const r = await capPost(A, p);
        results.push(`${r.status === 400 && r.json?.error === "invalid_request" && (await capRows(p.captureId)).length === 0 ? "ok" : "BAD"} ${label}: ${r.status}`);
      }
      record(
        results.every((l) => l.startsWith("ok")) && (await allRecordings()) === nBefore && (await acks(A.memberId)).length === 2,
        "captures 19f: a malformed stamp (version 0, a string version, a bad time, no time, an extra key) is 400 invalid_request, and nothing is written",
        results.filter((l) => l.startsWith("BAD")).join("; "),
      );
    }

    // ---- people ------------------------------------------------------------
    const peopleB = await http("GET", `/accounts/${acc}/people`, { token: B.token });
    const emailsB = (peopleB.json?.people ?? []).map((p: any) => p.email);
    const peopleA = await http("GET", `/accounts/${acc}/people`, { token: A.token });
    const emailsA = (peopleA.json?.people ?? []).map((p: any) => p.email);
    record(!emailsB.includes(people.hidden.email) && emailsB.includes(people.shared.email) && emailsB.includes(people.free.email), "people: someone seen only on another member's private call is not listed; people on shared calls and unattached people are", `${emailsB.filter((e: string) => e.endsWith(`-${tag}@clipwise.test`)).length} listed`);
    record(emailsA.includes(people.hidden.email), "people: the owner of that call does see them");
    record((await http("GET", `/accounts/${acc}/people/${people.hidden.id}`, { token: B.token })).status === 404, "people by id: the hidden person is 404");

    // ---- account in the URL is not trusted ---------------------------------
    record((await http("GET", `/accounts/${randomUUID()}/moments?q=${WORD}`, { token: A.token })).status === 404, "a URL naming a different account is 404");
    const me = await http("GET", "/accounts/me", { token: C.token });
    record(me.json?.member?.role === "admin" && me.json?.account?.id === acc, "/accounts/me: the caller's own account and role");

    // ---- calendar connect: a session, not a token ---------------------------
    // Any member connects their own calendar from a signed-in browser (SAA-227
    // decision 9); check-auth signs in and connects. A bearer token, a member's
    // or an admin's, gets no further than the session guard.
    const connectB = await http("GET", `/oauth/google/connect?account_id=${acc}`, { token: B.token });
    const connectC = await http("GET", `/oauth/google/connect?account_id=${acc}`, { token: C.token });
    record(connectB.status === 401 && connectC.status === 401, "calendar connect: a bearer token is refused (401), a member's and an admin's alike; it takes a signed-in session", `${connectB.status}/${connectC.status}`);

    // ---- calendar lookup: the owner's own connection only ---------------------
    // A connects, C connects, B does not. Each lookup returns that member's own
    // row; B's returns none, never A's or C's (SAA-227 decision 8). The tokens
    // are placeholders, encrypted with a key made for this run, and unexpired, so
    // nothing reaches Google.
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
    const connectionFor = async (who: Who): Promise<string> => {
      const [row] = await db
        .insert(schema.calendarConnections)
        .values({
          accountId: acc,
          memberId: who.memberId,
          calendarEmail: who.email,
          accessToken: encrypt(`check-access-${tag}-access`),
          refreshToken: encrypt(`check-access-${tag}-refresh`),
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          scope: "https://www.googleapis.com/auth/calendar.readonly",
          searchedCalendarIds: [who.email],
        })
        .returning({ id: schema.calendarConnections.id });
      return row.id;
    };
    const connA = await connectionFor(A);
    const connC = await connectionFor(C);
    const lookup = async (who: Who) => {
      const r = await resolveCalendarConnection(who.memberId);
      return "reason" in r ? r.reason : r.connection.id;
    };
    const [gotA, gotB, gotC] = [await lookup(A), await lookup(B), await lookup(C)];
    record(gotA === connA && gotC === connC, "calendar lookup: each owner gets their own connection (the control)", `A ${gotA === connA ? "own" : gotA}, C ${gotC === connC ? "own" : gotC}`);
    record(gotB === "not_connected", "calendar lookup: an owner with no connection gets none, never another member's", `B got ${gotB === connA ? "A's" : gotB === connC ? "C's" : gotB}`);

    // ---- the MCP endpoint ---------------------------------------------------
    let rpcId = 0;
    const rpc = async (token: string | undefined, method: string, params?: unknown) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, headers: res.headers };
    };
    const call = async (who: Who, name: string, args: Record<string, unknown>) => {
      const r = await rpc(who.token, "tools/call", { name, arguments: args });
      const result = r.json?.result;
      return { status: r.status, isError: result?.isError === true, text: String(result?.content?.[0]?.text ?? "") };
    };

    // What Claude does first: ask with no token, read the 401, follow it.
    const first = await rpc(undefined, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } });
    const challenge = first.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
    record(first.status === 401 && metadataUrl === `${cfg.baseURL}/.well-known/oauth-protected-resource`, "mcp: with no token /mcp answers 401 and points at the protected-resource metadata", `${first.status} ${challenge}`);
    const prm = await http("GET", new URL(metadataUrl || "/x", cfg.baseURL).pathname);
    record(prm.status === 200 && prm.json?.resource === cfg.mcpResource && prm.json?.authorization_servers?.[0] === `${cfg.baseURL}/api/auth`, "discovery: that document names this MCP URL exactly and the issuer first", JSON.stringify(prm.json));
    const prm2 = await http("GET", "/.well-known/oauth-protected-resource/mcp");
    record(JSON.stringify(prm2.json) === JSON.stringify(prm.json), "discovery: the path-inserted location serves the same document");
    const asAlias = await http("GET", "/.well-known/oauth-authorization-server/api/auth");
    const asNative = await http("GET", "/api/auth/.well-known/oauth-authorization-server");
    record(
      asAlias.status === 200 && asAlias.json?.issuer === `${cfg.baseURL}/api/auth` && JSON.stringify(asAlias.json) === JSON.stringify(asNative.json) && asAlias.json?.code_challenge_methods_supported?.includes("S256") && !!asAlias.json?.registration_endpoint,
      "discovery: the RFC 8414 location serves Better Auth's server metadata (issuer, S256, registration)",
      `${asAlias.status} ${asAlias.json?.issuer}`,
    );
    const loginPageRes = await fetch(`${base}/login?x=1`);
    const consentPageRes = await fetch(`${base}/consent?x=1`);
    const loginHtml = await loginPageRes.text();
    const csp = loginPageRes.headers.get("content-security-policy") ?? "";
    record(
      loginPageRes.status === 200 && consentPageRes.status === 200 && /script-src 'nonce-[^']+'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp) && /frame-ancestors 'none'/.test(csp) && (loginPageRes.headers.get("cache-control") ?? "").includes("no-store") && loginHtml.includes(csp.match(/nonce-([^']+)/)![1]),
      "pages: /login and /consent are served with a nonce-only CSP, no framing, no caching",
      csp.slice(0, 120),
    );
    const consentHtml = await consentPageRes.text();
    record(/protocol === 'https:'/.test(consentHtml) && /hostname === 'localhost'/.test(consentHtml) && /location\.assign\(url\)/.test(consentHtml) && !/javascript:/.test(consentHtml.replace(/'[^']*'/g, "")), "pages: the consent page only navigates to an https (or loopback http) address — the redirect-URI script-injection advisory");

    // The hand-off the login page performs: an unauthenticated authorize goes to /login, and after
    // sign-in the same query goes back to authorize and on to /consent.
    {
      const email = C.email;
      const verifier = randomBytes(32).toString("base64url");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        scope: "offline_access",
        state: "s",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource: cfg.mcpResource,
      });
      const noSession = await http("GET", `/api/auth/oauth2/authorize?${q}`);
      const toLogin = String(noSession.json?.url ?? noSession.headers.get("location") ?? "");
      const signIn = await http("POST", "/api/auth/sign-in/email", { json: { email, password: PASSWORD } });
      const again = await http("GET", `/api/auth/oauth2/authorize${toLogin.slice(toLogin.indexOf("?"))}`, { cookie: signIn.cookie });
      const toConsent = String(again.json?.url ?? again.headers.get("location") ?? "");
      // /consent the first time; the callback with a code once consent is remembered (C has connected before).
      record(toLogin.startsWith("/login?") && (toConsent.startsWith("/consent?") || toConsent.startsWith("https://claude.ai/api/mcp/auth_callback?code=")), "login hand-off: no session → /login; sign in and return the same query → on to consent or straight to the callback with a code", `${toLogin.slice(0, 20)} → ${toConsent.slice(0, 40)}`);
    }

    // Scope variants a client may ask for: the connection must work whatever Claude requests.
    for (const scope of ["offline_access", "openid offline_access", ""]) {
      const t = await tokensFor(C.email, scope);
      const ok = (await rpc(t.access, "tools/list")).status === 200;
      record(ok && !!t.access, `oauth: a token obtained asking for scope "${scope}" works on /mcp${scope.includes("offline_access") ? ` (refresh token ${t.refresh ? "issued" : "NOT issued"})` : ""}`, "no token");
    }

    // The MCP handshake and the tool list, against the classification table.
    const init = await rpc(A.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } });
    record(init.status === 200 && init.json?.result?.serverInfo?.name === "clipwise" && !!init.json?.result?.capabilities?.tools && typeof init.json?.result?.instructions === "string", "mcp: initialize answers with the server's name, tools capability and instructions", JSON.stringify(init.json)?.slice(0, 160));
    const listA = await rpc(A.token, "tools/list");
    const tools: any[] = listA.json?.result?.tools ?? [];
    const actualNames = tools.map((t) => t.name);
    const classified = Object.keys(MCP_TOOLS);
    record(
      sameSet(actualNames, classified),
      `mcp tools: the server's actual tool list (${actualNames.join(", ")}) is exactly the classified list (${classified.join(", ")})`,
      `unclassified: ${actualNames.filter((n) => !classified.includes(n)).join(",") || "-"}; missing: ${classified.filter((n) => !actualNames.includes(n)).join(",") || "-"}`,
    );
    record(tools.every((t) => t.annotations?.readOnlyHint === true && t.inputSchema?.type === "object" && typeof t.description === "string" && t.description.length > 100), "mcp tools: every tool is declared read-only, with an object input schema and a real description");
    const toolsB = await rpc(B.token, "tools/list");
    record(sameSet((toolsB.json?.result?.tools ?? []).map((t: any) => t.name), classified), "mcp tools: the same list for another member");

    // Tools run as the caller: same visibility as the REST routes.
    const searchVia = async (who: Who) => {
      const r = await call(who, "search_moments", { query: WORD, scope: "all", limit: 200 });
      let body: any = {};
      try {
        body = JSON.parse(r.text);
      } catch {
        body = {};
      }
      return { r, set: new Set<string>((body.moments ?? []).map((m: any) => String(m.title).replace(`${WORD} `, ""))), body };
    };
    const mA = await searchVia(A);
    const mB = await searchVia(B);
    const mC = await searchVia(C);
    record(sameSet(mA.set, [...sa.set]) && sameSet(mB.set, [...sb.set]) && sameSet(mC.set, [...sc.set]), "mcp search_moments: each caller gets exactly what the REST search gives them (owner, member, admin)", `${[...mB.set].join(",")}`);
    record(!mB.set.has("a1") && !mB.set.has("a3") && !mB.set.has("a2 personnel") && mB.body.totalMatches === 4, "mcp search_moments: another member's search leaves out the private call, the personal call and the personnel moment; the count agrees");

    const trB1 = await call(B, "get_transcript", { recordingId: rec.a1.id });
    const trB2 = await call(B, "get_transcript", { recordingId: rec.a2.id });
    const trA1 = await call(A, "get_transcript", { recordingId: rec.a1.id });
    record(trB1.isError && trB1.text.includes("recording_not_found") && !trB1.text.includes("words a1"), "mcp get_transcript: a private call is 'not found' to another member, as a tool error");
    record(!trB2.isError && trB2.text.includes("words a2") && trB2.text.includes("last page") && trB2.text.includes("[#0 0:00]"), "mcp get_transcript: a shared call reads as numbered, timed lines and says it is the last page", trB2.text.slice(0, 200));
    record(!trA1.isError && trA1.text.includes("words a1"), "mcp get_transcript: the owner reads their own private call");

    // SAA-226: a long transcript comes back a page at a time, every segment exactly once.
    const SEGS = 120;
    const [pr] = await db
      .insert(schema.recordings)
      .values({ accountId: acc, ownerMemberId: A.memberId, visibility: "shared", scope: "work", slug: `check-access-${tag}-long`, title: `long ${tag}`, source: "check-access", sourceId: `${tag}-long`, startedAt: new Date(), durationSec: SEGS * 3 })
      .returning({ id: schema.recordings.id });
    const [ptr] = await db.insert(schema.transcripts).values({ recordingId: pr.id, provider: "check", status: "ready" }).returning({ id: schema.transcripts.id });
    const filler = "lorem ipsum dolor sit amet ".repeat(11).trim();
    await db.insert(schema.segments).values(
      Array.from({ length: SEGS }, (_, i) => ({ accountId: acc, recordingId: pr.id, transcriptId: ptr.id, startSec: i * 3, endSec: i * 3 + 2.5, text: `${filler} #${i}`, orderIndex: i })),
    );
    const seen: number[] = [];
    let cursor: number | null = 0;
    let pages = 0;
    let longestPage = 0;
    let walked = true;
    while (cursor !== null && pages < 400) {
      const r = await call(B, "get_transcript", { recordingId: pr.id, fromSegment: cursor, maxChars: 5000 });
      if (r.isError) {
        walked = false;
        break;
      }
      pages++;
      longestPage = Math.max(longestPage, r.text.length);
      for (const m of r.text.matchAll(/^\[#(\d+) /gm)) seen.push(Number(m[1]));
      const next = /fromSegment=(\d+)/.exec(r.text);
      cursor = /NOT THE LAST PAGE/.test(r.text) && next ? Number(next[1]) : null;
    }
    record(walked && seen.length === SEGS && seen.every((v, i) => v === i) && pages > 1, `mcp get_transcript: a ${SEGS}-segment transcript read in ${pages} pages of 5,000 characters returns every segment exactly once`, `walked ${walked}; saw ${seen.length}; ${pages} pages`);
    record(longestPage < 5000 + 700, "mcp get_transcript: no page is longer than its budget plus the notice", `longest ${longestPage}`);
    const fromSec = await call(B, "get_transcript", { recordingId: pr.id, fromSec: 30, maxChars: 2000 });
    record(fromSec.text.includes("[#10 0:30]") && !fromSec.text.includes("[#9 "), "mcp get_transcript: fromSec jumps to the segment running at that second");
    const badId = await call(B, "get_transcript", { recordingId: "not-a-uuid" });
    record(badId.isError && badId.text.startsWith("invalid_arguments"), "mcp get_transcript: a bad argument is a tool error naming the problem");
    const unknownTool = await call(B, "delete_everything", {});
    record(unknownTool.isError && unknownTool.text.startsWith("unknown_tool"), "mcp: an unknown tool is a tool error");

    // Search results are cut to a size a client can take, and say so.
    const bulkRows = Array.from({ length: 150 }, (_, i) => ({
      accountId: acc,
      recordingId: pr.id,
      kind: "observation",
      title: `bulk${tag} ${i}`,
      summary: `bulk${tag} ${"filler text for size ".repeat(40)}${i}`,
      startSec: i,
      endSec: i + 1,
      metadata: { source: "hand_curated" },
    }));
    await db.insert(schema.moments).values(bulkRows);
    const bulk = await call(B, "search_moments", { query: `bulk${tag}`, scope: "all", limit: 200 });
    let bulkBody: any = {};
    try {
      bulkBody = JSON.parse(bulk.text);
    } catch {
      bulkBody = {};
    }
    record(
      bulk.text.length <= 60_000 && bulkBody.trimmedForSize === true && bulkBody.truncated === true && bulkBody.totalMatches === 150 && bulkBody.moments.length === bulkBody.returned && bulkBody.returned < 150 && bulkBody.returned > 10 && typeof bulkBody.note === "string",
      "mcp search_moments: a result over ~60,000 characters is cut from the end to fit, and says so (trimmedForSize, truncated, returned, totalMatches)",
      `${bulk.text.length} chars; returned ${bulkBody.returned} of ${bulkBody.totalMatches}`,
    );
    const small = await call(B, "search_moments", { query: `bulk${tag}`, scope: "all", limit: 5 });
    record(JSON.parse(small.text).trimmedForSize === undefined && JSON.parse(small.text).moments.length === 5, "mcp search_moments: a result that fits is not touched");

    // No token, a junk token, and the methods that are refused.
    record((await rpc(undefined, "tools/list")).status === 401 && (await rpc("junk.junk.junk", "tools/call", { name: "get_transcript", arguments: { recordingId: rec.a2.id } })).status === 401, "mcp: tools/list and tools/call without a valid token are 401, not tool results");
    const getMcp = await http("GET", "/mcp", { token: A.token });
    const delMcp = await http("DELETE", "/mcp", { token: A.token });
    record(getMcp.status === 405 && delMcp.status === 405 && (await http("GET", "/mcp")).status === 401, "mcp: GET and DELETE are 405 once authenticated, 401 before");

    // ---- 4. two kinds of token (SAA-244) -----------------------------------
    const FOUR = [...MCP_SCOPES] as string[];

    // The recorder client gets a capture token.
    const capClaims = capA.access ? await verifyAccessToken(capA.access, "capture") : null;
    const capAsMcp = capA.access ? await verifyAccessToken(capA.access, "mcp") : null;
    record(
      !!capClaims && capClaims.scope.includes(CAPTURE_SCOPE) && capAsMcp === null && !!capA.refresh,
      "recorder client: obtains a token for the capture resource with the capture scope and a refresh token (loopback redirect, any port)",
      `error ${capA.error} at ${capA.step}`,
    );
    // It works on a capture route, and is refused on /mcp and on a read route.
    const capCreate = await http("POST", `/accounts/${acc}/recordings`, { token: capA.access ?? "", json: { title: `check-access ${tag} capture`, slug: `check-access-${tag}-cap` } });
    record(capCreate.status === 201, "recorder token: works on a capture route (POST /accounts/:accountId/recordings creates a recording)", `${capCreate.status} ${capCreate.json?.error ?? ""}`);
    const capOnMcp = await rpc(capA.access ?? "", "tools/list");
    const capOnRead = await http("GET", "/accounts/me", { token: capA.access ?? "" });
    record(capOnMcp.status === 401 && capOnRead.status === 401, "recorder token: refused on /mcp and on a read route (GET /accounts/me)", `/mcp ${capOnMcp.status}, read ${capOnRead.status}`);
    // An MCP token is refused on a capture route with the scope it lacks.
    const mcpOnCapture = await http("POST", `/accounts/${acc}/recordings`, { token: A.token, json: { slug: `check-access-${tag}-mcp` } });
    record(
      mcpOnCapture.status === 403 &&
        mcpOnCapture.json?.error === "insufficient_scope" &&
        (mcpOnCapture.headers.get("www-authenticate") ?? "").includes('error="insufficient_scope"'),
      "MCP token: refused on a capture route with 403 insufficient_scope and a challenge naming the scope",
      `${mcpOnCapture.status} ${mcpOnCapture.json?.error ?? ""} ${mcpOnCapture.headers.get("www-authenticate") ?? ""}`,
    );

    // The recorder's Sign out (SAA-198 step 5): what the tray runs,
    // recorder/app/capture-sign-out.js, called here against this server, then
    // the refresh token tried. Loaded the way main.js loads it; code without it
    // signs out on the Mac only, and the token still works.
    const signOutModule = (() => {
      try {
        return createRequire(import.meta.url)("../../../recorder/app/capture-sign-out.js") as {
          REVOKE_PATH: string;
          revokeRefreshToken: (server: string, refresh: string, clientId: string) => Promise<string>;
        };
      } catch {
        return null;
      }
    })();
    const refreshWith = (refresh: string | null) =>
      http("POST", "/api/auth/oauth2/token", {
        form: { grant_type: "refresh_token", refresh_token: refresh ?? "", client_id: recorder.clientId, resource: cfg.captureResource },
      });
    const signedOut = await recFlow(A);
    const signOutOutcome = signOutModule ? await signOutModule.revokeRefreshToken(base, signedOut.refresh ?? "", recorder.clientId) : "(Mac's copy only: no revoke)";
    const afterSignOut = await refreshWith(signedOut.refresh);
    record(
      !!signedOut.refresh && afterSignOut.status >= 400 && !afterSignOut.json?.access_token,
      "recorder Sign out: the refresh token is revoked on the server, and a refresh with it afterwards is refused",
      `sign-out ${signOutOutcome}; refresh afterwards ${afterSignOut.status} ${afterSignOut.json?.error ?? (afterSignOut.json?.access_token ? "(new access token issued)" : "")}`,
    );
    const stillSignedIn = await recFlow(A);
    const notSignedOut = await refreshWith(stillSignedIn.refresh);
    record(
      notSignedOut.status === 200 && !!notSignedOut.json?.access_token,
      "recorder Sign out, the control: a refresh token that was not signed out still refreshes",
      `refresh ${notSignedOut.status} ${notSignedOut.json?.error ?? ""}`,
    );
    const discovery = await http("GET", "/.well-known/oauth-authorization-server/api/auth");
    const advertised = String(discovery.json?.revocation_endpoint ?? "");
    let advertisedPath = "";
    try { advertisedPath = new URL(advertised).pathname; } catch {}
    record(
      !!signOutModule && advertisedPath === signOutModule.REVOKE_PATH,
      "recorder Sign out: its fixed revoke path is the revocation_endpoint the discovery document names",
      `discovery ${advertisedPath || "(none)"}, recorder ${signOutModule?.REVOKE_PATH ?? "(no module)"}`,
    );

    // Every route that needs a token takes the kind its table entry says, and
    // refuses the other. A capture route answers an MCP token 403
    // insufficient_scope; an MCP route answers a capture token 401.
    const tableBody = (key: string): Record<string, unknown> =>
      key === "POST /accounts/:accountId/recordings" ? { slug: `check-access-${tag}-tbl` } : {};
    for (const key of listed) {
      const entry = ROUTES[key];
      if (!entry || entry.requires === "public") continue;
      const [method, path] = key.split(" ");
      const real = method === "ALL" ? "GET" : method;
      const json = real === "POST" ? tableBody(key) : undefined;
      const asMcp = await http(real, fill(path), { token: C.token, json });
      const asCap = await http(real, fill(path), { token: capC.access ?? "", json });
      const insufficient = (r: Reply) => r.status === 403 && r.json?.error === "insufficient_scope";
      const through = (r: Reply) => r.status !== 401 && !insufficient(r);
      // A session route takes neither token.
      const ok =
        entry.requires === "capture"
          ? insufficient(asMcp) && through(asCap)
          : entry.requires === "session"
            ? asMcp.status === 401 && asCap.status === 401
            : through(asMcp) && asCap.status === 401;
      record(
        ok,
        entry.requires === "session" ? `requires: ${key} takes a session and refuses both tokens` : `requires: ${key} takes a ${entry.requires} token and refuses the other`,
        `table says ${entry.requires}; MCP token → ${asMcp.status}${asMcp.json?.error ? ` ${asMcp.json.error}` : ""}; capture token → ${asCap.status}${asCap.json?.error ? ` ${asCap.json.error}` : ""}`,
      );
    }

    // Dynamic registration is open to anyone, and cannot reach the capture scope
    // or the capture resource.
    const dcrBody = (extra: Record<string, unknown>) => ({
      client_name: `check-access-${tag}-dcr`,
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...extra,
    });
    const register = async (json: Record<string, unknown>, via?: ReturnType<typeof createAuth>): Promise<{ status: number; json: any }> => {
      if (!via) return http("POST", "/api/auth/oauth2/register", { json });
      const res = await via.handler(
        new Request(`${cfg.baseURL}/api/auth/oauth2/register`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: cfg.baseURL },
          body: JSON.stringify(json),
        }),
      );
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: res.status, json: parsed };
    };
    // THE assertion the second control targets: with the control it is the only
    // one that runs against a provider built without clientRegistrationDefaultScopes.
    const controlAuth = CONTROL === "no-registration-defaults" ? createAuth(cfg, { omitRegistrationDefaultScopes: true }) : undefined;
    const askCapture = await register(dcrBody({ scope: `openid ${CAPTURE_SCOPE}` }), controlAuth);
    record(
      askCapture.status === 400 && askCapture.json?.error === "invalid_scope",
      "dynamic registration: a client asking for the capture scope is refused (invalid_scope)",
      `${askCapture.status} ${askCapture.json?.error ?? ""}; registered scope: ${askCapture.json?.scope ?? "(none)"}`,
    );
    const askResource = await register(dcrBody({ resources: [cfg.captureResource] }));
    record(
      askResource.status === 400 && askResource.json?.error === "invalid_target",
      "dynamic registration: a client asking for the capture resource is refused (invalid_target)",
      `${askResource.status} ${askResource.json?.error ?? ""}`,
    );
    const plain = await register(dcrBody({}));
    const plainScopes = String(plain.json?.scope ?? "").split(" ").filter(Boolean);
    record(
      plain.status === 201 && sameSet(plainScopes, FOUR),
      "dynamic registration: a client that names no scope is registered with the four MCP scopes and nothing else",
      `${plain.status}; scope: ${plainScopes.join(" ")}`,
    );
    // And a dynamically registered client cannot ask for either at sign-in.
    const dcrId = String(plain.json?.client_id ?? "");
    const dcrCallback = "https://claude.ai/api/mcp/auth_callback";
    const dcrScope = await oauthFlow({ email: A.email, clientId: dcrId, redirectUri: dcrCallback, scope: `openid ${CAPTURE_SCOPE}`, resource: cfg.mcpResource });
    record(!dcrScope.access && dcrScope.error === "invalid_scope", "dynamic client at sign-in: asking for the capture scope is refused (invalid_scope)", `${dcrScope.error} at ${dcrScope.step}`);
    const dcrResource = await oauthFlow({ email: A.email, clientId: dcrId, redirectUri: dcrCallback, scope: "openid offline_access", resource: cfg.captureResource });
    record(!dcrResource.access && dcrResource.error === "invalid_target", "dynamic client at sign-in: asking for the capture resource is refused (invalid_target)", `${dcrResource.error} at ${dcrResource.step}`);

    // Only the recorder's client is linked to the capture resource, and making
    // it again changes nothing.
    const recorderAgain = await ensureRecorderClient();
    const links = await pool.query(`select "clientId" from "oauthClientResource" where "resourceId" = $1`, [cfg.captureResource]);
    const recorderRows = await pool.query(`select count(*)::int as n from "oauthClient" where "clientId" = $1`, [recorder.clientId]);
    record(
      sameSet(links.rows.map((r: any) => r.clientId), [recorder.clientId]) && recorderRows.rows[0].n === 1 && recorderAgain.created === false,
      "the recorder's client is the only one linked to the capture resource, and creating it again adds nothing",
      `linked: ${links.rows.map((r: any) => r.clientId).join(", ")}; client rows: ${recorderRows.rows[0].n}; second run created: ${recorderAgain.created}`,
    );

    // What claude.ai reads is unchanged, and an MCP client's refresh still works.
    const asMeta = await http("GET", "/.well-known/oauth-authorization-server/api/auth");
    const prMeta = await http("GET", "/.well-known/oauth-protected-resource");
    record(
      asMeta.status === 200 && sameSet(asMeta.json?.scopes_supported ?? [], FOUR) && prMeta.status === 200 && !("scopes_supported" in (prMeta.json ?? {})),
      "discovery is unchanged: the authorization server advertises the four MCP scopes, the protected-resource document advertises none",
      `AS ${JSON.stringify(asMeta.json?.scopes_supported)}; resource ${JSON.stringify(prMeta.json?.scopes_supported)}`,
    );
    const mcpTok = await tokensFor(A.email);
    const refreshed = await http("POST", "/api/auth/oauth2/token", {
      form: { grant_type: "refresh_token", refresh_token: mcpTok.refresh ?? "", client_id: mcpTok.clientId, resource: cfg.mcpResource },
    });
    const refreshedMcp = refreshed.json?.access_token ? await rpc(refreshed.json.access_token, "tools/list") : null;
    record(refreshedMcp?.status === 200, "an MCP client's refresh grant still yields a token that works on /mcp", `refresh ${refreshed.status}; /mcp ${refreshedMcp?.status ?? "(no token)"}`);

    // ---- fail closed -------------------------------------------------------
    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    const unconfigured = await http("GET", "/accounts/me", { token: A.token });
    process.env.BETTER_AUTH_SECRET = saved;
    record(unconfigured.status === 503, "with no sign-in configured, content routes answer 503, not data", `status ${unconfigured.status}`);

    // ---- revocation --------------------------------------------------------
    const before = await http("GET", `/accounts/${acc}/moments?q=${WORD}&scope=all`, { token: B.token });
    await removeMember(B.email);
    const after = await http("GET", `/accounts/${acc}/moments?q=${WORD}&scope=all`, { token: B.token });
    const afterMe = await http("GET", "/accounts/me", { token: B.token });
    const afterTr = await http("GET", `/recordings/${rec.a2.id}/transcript`, { token: B.token });
    const afterMcp = await rpc(B.token, "tools/list");
    record(before.status === 200 && after.status === 401 && afterMe.status === 401 && afterTr.status === 401 && afterMcp.status === 401, "revocation: removing a member makes their still-valid token 401 on the very next call, on every route and on /mcp", `before ${before.status}; after ${after.status}/${afterMe.status}/${afterTr.status}/mcp ${afterMcp.status}`);
    {
      const p = capPayload();
      const r = await capPost(B, p);
      record(r.status === 401 && (await capRows(p.captureId)).length === 0, "captures 13: a removed member's still-valid capture token is 401 on POST /captures, and nothing is written", `got ${r.status}`);
    }
    if (B.refresh) {
      const refreshed = await http("POST", "/api/auth/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: B.refresh, client_id: clientId, resource: cfg.mcpResource } });
      record(refreshed.status >= 400 && !refreshed.json?.access_token, "revocation: a removed member's refresh token no longer yields a new access token", `status ${refreshed.status}`);
    } else {
      record(false, "revocation: a refresh token was issued to test with", "none issued");
    }
    record((await http("GET", `/accounts/${acc}/moments?q=${WORD}&scope=all`, { token: A.token })).status === 200, "revocation: other members are unaffected");
  } finally {
    server.close();
    await cleanup(acc);
  }
}

main()
  .catch((err) => {
    failed++;
    total++;
    process.stderr.write(`FAIL check-access crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  })
  .finally(async () => {
    process.stdout.write(`\n${total - failed}/${total} passed\n`);
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  });
