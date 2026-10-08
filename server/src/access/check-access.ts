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
//  4. Revocation: a member's still-valid token stops working on the next call
//     once they are removed.
//
// WRITES to the database it is pointed at (tagged rows, removed at the end), so
// it refuses to run unless told the database is a scratch one. The database
// must be provisioned and have its account.
//
// Usage:
//   CLIPWISE_CHECK_SCRATCH_DB=1 tsx src/access/check-access.ts
// with DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, AUTH_PASSWORD_ENABLED=true.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { authConfigFromEnv } from "../auth/auth.js";
import { addMember, createPasswordLogin, removeMember, requireAccount } from "../auth/members.js";
import { db, pool, schema } from "../db/index.js";
import { MCP_TOOLS, ROUTES } from "./classification.js";
import { listRoutes } from "./route-list.js";

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
  o: { token?: string; json?: unknown; form?: Record<string, string>; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { origin: cfg.baseURL, ...o.headers };
  let body: string | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
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
async function tokenFor(email: string): Promise<string> {
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
  const signIn = await http("POST", "/api/auth/sign-in/email", { json: { email, password: PASSWORD } });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    scope: "openid offline_access",
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: cfg.mcpResource,
  });
  const authorize = await http("GET", `/api/auth/oauth2/authorize?${query}`, { cookie: signIn.cookie });
  const consentQuery = String(authorize.json?.url ?? "").split("?")[1];
  const consent = await http("POST", "/api/auth/oauth2/consent", {
    json: { accept: true, oauth_query: consentQuery },
    cookie: signIn.cookie,
  });
  const code = new URL(consent.json.url).searchParams.get("code")!;
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
  return token.json.access_token as string;
}

type Who = { email: string; memberId: string; token: string };
async function makeUser(label: string, role: "admin" | "member"): Promise<Who> {
  const email = `${label}-${tag}@clipwise.test`;
  const member = await addMember({ email, role, name: `Check ${label}` });
  await createPasswordLogin(email, `Check ${label}`, PASSWORD);
  return { email, memberId: member.id, token: await tokenFor(email) };
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
    // ---- 1. classification -------------------------------------------------
    const listed = listRoutes(app, mounts).map((r) => `${r.method} ${r.path}`);
    const unclassified = listed.filter((k) => !ROUTES[k]);
    const stale = Object.keys(ROUTES).filter((k) => !listed.includes(k));
    record(unclassified.length === 0, `every route on the app is classified (${listed.length} routes)`, `unclassified: ${unclassified.join("; ")}`);
    record(stale.length === 0, "every classified route exists on the app", `missing: ${stale.join("; ")}`);
    record(
      Object.values(MCP_TOOLS).every((t) => t.access === "member"),
      `MCP tools classified (${Object.keys(MCP_TOOLS).join(", ")}); enumerated against the server's tool list when /mcp lands`,
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

    // ---- writes are the owner's --------------------------------------------
    const addAtt = (who: Who, key: string) => http("POST", `/accounts/${acc}/recordings/${rec[key].id}/attendees`, { token: who.token, json: { name: "Added" } });
    record((await addAtt(B, "a2")).status === 404 && (await addAtt(A, "a2")).status === 201, "attendees: only the owner can add one — even to a shared call");
    const addMoment = (who: Who, key: string) => http("POST", `/accounts/${acc}/moments`, { token: who.token, json: { recordingId: rec[key].id, kind: "observation", title: `${WORD} added`, startSec: 0, endSec: 1 } });
    record((await addMoment(B, "a2")).status === 404 && (await addMoment(A, "a2")).status === 201, "moments: only the owner can add one");
    record((await http("POST", `/recordings/${rec.a2.id}/transcript`, { token: B.token, json: {} })).status === 404, "transcript: only the owner can add one");

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
    record(before.status === 200 && after.status === 401 && afterMe.status === 401 && afterTr.status === 401, "revocation: removing a member makes their still-valid token 401 on the very next call, on every route", `before ${before.status}; after ${after.status}/${afterMe.status}/${afterTr.status}`);
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
