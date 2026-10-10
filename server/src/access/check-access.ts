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
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { authConfigFromEnv, createAuth } from "../auth/auth.js";
import { addMember, createPasswordLogin, removeMember, requireAccount } from "../auth/members.js";
import { ensureRecorderClient, RECORDER_CLIENT_ID, RECORDER_REDIRECT_URI } from "../auth/recorder-client.js";
import { CAPTURE_SCOPE, MCP_SCOPES } from "../auth/scopes.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { db, pool, schema } from "../db/index.js";
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
    const fill = (p: string) => p.replace(":accountId", acc).replace(":id", randomUUID()).replace("/*", "/ok");
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
        classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[] },
        capture: { tracks: { tap: { verdict: "ok" }, mic: { verdict: "ok" } }, permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
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

    // ---- admin-only --------------------------------------------------------
    const connectB = await http("GET", `/oauth/google/connect?account_id=${acc}`, { token: B.token });
    const connectC = await http("GET", `/oauth/google/connect?account_id=${acc}`, { token: C.token });
    record(connectB.status === 403 && connectC.status !== 401 && connectC.status !== 403, "calendar connect: a member is refused (403); an admin gets past the gate", `${connectB.status}/${connectC.status}`);

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
      const ok = entry.requires === "capture" ? insufficient(asMcp) && through(asCap) : through(asMcp) && asCap.status === 401;
      record(
        ok,
        `requires: ${key} takes a ${entry.requires} token and refuses the other`,
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
