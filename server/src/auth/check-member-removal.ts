// Check for a member's removal (SAA-347) below the route: what Google is told,
// and that the removal is one transaction. Real database, the scratch
// instance's one account. Google is a stand-in for the whole run, never the real
// one: fetch is replaced, answers https://oauth2.googleapis.com/revoke as each
// case says, and fails any other request.
//
//   g1-g4  revokeToken: 200 is revoked, 400 invalid_token already_invalid, 503
//          refused (status and error word kept), a thrown fetch unreachable;
//          each one form POST of token=<the token> to the revoke URL
//   m1     a member with five connections, Google answering four of them 200,
//          400 invalid_token, 503 and a throw, and one whose token cannot be
//          decrypted: the removal completes (removed, 0 connections), each
//          outcome is reported by connection id, not_attempted for the fifth,
//          which Google is never asked about, and the Third-party apps line is
//          there
//   m2     control for the line: revoked and already_invalid only, no line
//   m3     no report, as JSON or as the CLI prints it, has an email or a token
//   a1     atomicity: a trigger made for this run raises on deleting this
//          member's calendar row, the transaction's last step: removeMember
//          throws, the member is still active with both calls and the row, and
//          Google was not asked
//   a2     the trigger and its function are dropped, and are gone from pg_trigger
//          and pg_proc (seen there before the drop)
//   a3     control: with the trigger gone, the same removal completes
//
//   scripts/scratch-db.sh run check-member-removal

import { randomBytes, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { deleteRecordings } from "../db/delete-recordings.js";
import { endPool, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { encrypt } from "../lib/crypto.js";
import { revokeToken } from "../lib/google-calendar.js";
import { formatRemovalReport, GOOGLE_ACCESS_NOTE, removeMember, requireAccount } from "./members.js";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (ok) passes++;
  else failures++;
}

const TAG = randomUUID().slice(0, 8);
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

type Seen = { url: string; method: string; type: string | null; body: string };
const seen: Seen[] = [];
let answer: (token: string) => Response | "throw" = () => new Response("", { status: 200 });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = String(init?.body ?? "");
  seen.push({ url, method: init?.method ?? "GET", type: new Headers(init?.headers).get("content-type"), body });
  if (url !== REVOKE_URL) throw new Error(`stand-in: a request that is not Google's revoke: ${url}`);
  const a = answer(new URLSearchParams(body).get("token") ?? "");
  if (a === "throw") throw new TypeError("fetch failed");
  return a;
}) as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokensSeen = () => seen.map((s) => new URLSearchParams(s.body).get("token"));

async function member(accountId: string, label: string) {
  const [m] = await db.insert(schema.accountMembers).values({ accountId, email: `cmr-${label}-${TAG}@clipwise.test`, role: "member", joinedAt: new Date() }).returning();
  return m;
}
async function connection(accountId: string, memberId: string, n: number, stored: string): Promise<string> {
  const [c] = await db
    .insert(schema.calendarConnections)
    .values({ accountId, memberId, calendarEmail: `cmr-cal${n}-${TAG}@clipwise.test`, accessToken: encrypt(`cmr-access-${TAG}-${n}`), refreshToken: stored, tokenExpiresAt: new Date(Date.now() + 3_600_000), scope: "check", searchedCalendarIds: [] })
    .returning({ id: schema.calendarConnections.id });
  return c.id;
}
async function call(accountId: string, memberId: string, n: number, scope: "work" | "personal", trashed: boolean): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.recordings).values({
    id, accountId, ownerMemberId: memberId, slug: `cmr-${TAG}-${n}`, title: `check call ${n}`, source: "check", sourceId: id,
    status: "ready", scope, visibility: "private", trashedAt: trashed ? new Date() : null, metadata: {},
  });
  return id;
}
const n = async (q: string, p: unknown[]) => Number((await pool.query(q, p)).rows[0].n);
const removedAt = async (id: string) => (await pool.query(`select removed_at from account_members where id = $1`, [id])).rows[0]?.removed_at ?? null;
const connections = (memberId: string) => n(`select count(*) as n from calendar_connections where member_id = $1`, [memberId]);
const errText = (e: unknown) => (e instanceof Error ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ""}` : String(e));

async function main(): Promise<void> {
  await refuseUnlessScratch("check-member-removal");
  const account = await requireAccount();
  const made: string[] = [];
  const secrets: string[] = [];
  const trig = `cmr_fail_${TAG}`;
  try {
    const cases = [
      ["g1", () => json(200, {}), { outcome: "revoked" }],
      ["g2", () => json(400, { error: "invalid_token", error_description: "Token expired or revoked" }), { outcome: "already_invalid" }],
      ["g3", () => json(503, { error: "backend_error" }), { outcome: "refused", status: 503, error: "backend_error" }],
      ["g4", () => "throw" as const, { outcome: "unreachable" }],
    ] as const;
    for (const [name, a, want] of cases) {
      seen.length = 0;
      answer = a;
      const token = `cmr-${name}-${TAG}`;
      const got = await revokeToken(token);
      const req = seen[0];
      check(`${name}: revokeToken is ${want.outcome}, from one form POST of the token to Google's revoke URL`,
        JSON.stringify(got) === JSON.stringify(want) && seen.length === 1 && req.url === REVOKE_URL && req.method === "POST"
          && req.type === "application/x-www-form-urlencoded" && req.body === `token=${token}`,
        `got ${JSON.stringify(got)}; requests ${JSON.stringify(seen)}`);
    }

    const m1 = await member(account.id, "m1");
    made.push(m1.id);
    const t = ["ok", "gone", "busy", "down"].map((k) => `cmr-m1-${k}-${TAG}`);
    secrets.push(...t);
    const id: Record<string, string> = {};
    for (const [i, tok] of t.entries()) id[tok] = await connection(account.id, m1.id, i, encrypt(tok));
    const broken = await connection(account.id, m1.id, 9, "not.a.ciphertext");
    answer = (tok) => (tok === t[0] ? json(200, {}) : tok === t[1] ? json(400, { error: "invalid_token" }) : tok === t[2] ? json(503, {}) : "throw");
    seen.length = 0;
    const r1 = (await removeMember(m1.email)).report;
    const of = (cid: string) => r1.calendar.google.find((g) => g.connectionId === cid);
    check("m1: the removal completes whatever Google answers: removed, 0 calendar connections, 5 reported deleted",
      (await removedAt(m1.id)) !== null && (await connections(m1.id)) === 0 && r1.calendar.connectionsDeleted === 5, JSON.stringify(r1.calendar));
    check("m1: each connection's outcome by id: revoked, already_invalid, refused 503, unreachable, and not_attempted for the one that cannot be decrypted",
      r1.calendar.google.length === 5 && of(id[t[0]])?.outcome === "revoked" && of(id[t[1]])?.outcome === "already_invalid"
        && of(id[t[2]])?.outcome === "refused" && of(id[t[2]])?.status === 503 && of(id[t[3]])?.outcome === "unreachable" && of(broken)?.outcome === "not_attempted",
      JSON.stringify(r1.calendar.google));
    check("m1: Google is asked once for each of the four decryptable tokens, and never about the fifth",
      seen.length === 4 && seen.every((s) => s.url === REVOKE_URL) && JSON.stringify([...tokensSeen()].sort()) === JSON.stringify([...t].sort()), JSON.stringify(tokensSeen()));
    check("m1: the report carries the Third-party apps line", r1.adminNote === GOOGLE_ACCESS_NOTE && GOOGLE_ACCESS_NOTE.includes("myaccount.google.com → Third-party apps"), String(r1.adminNote));

    const m2 = await member(account.id, "m2");
    made.push(m2.id);
    const t2 = [`cmr-m2-ok-${TAG}`, `cmr-m2-gone-${TAG}`];
    secrets.push(...t2);
    await connection(account.id, m2.id, 0, encrypt(t2[0]));
    await connection(account.id, m2.id, 1, encrypt(t2[1]));
    answer = (tok) => (tok === t2[0] ? json(200, {}) : json(400, { error: "invalid_token" }));
    const r2 = (await removeMember(m2.email)).report;
    check("m2: control: revoked and already_invalid only, and the report has no Third-party apps line",
      r2.adminNote === null && JSON.stringify(r2.calendar.google.map((g) => g.outcome).sort()) === JSON.stringify(["already_invalid", "revoked"]), JSON.stringify(r2.calendar));

    const text = JSON.stringify([r1, r2]) + "\n" + [...formatRemovalReport(r1), ...formatRemovalReport(r2)].join("\n");
    check("m3: no report, as JSON or as the CLI prints it, carries an email or a token (the members' emails and tokens all exist: control)",
      !text.includes("@") && !secrets.some((s) => text.includes(s)) && m1.email.includes("@") && formatRemovalReport(r1).some((l) => l.includes(r1.memberId)), text.slice(0, 400));

    const m3 = await member(account.id, "a1");
    made.push(m3.id);
    const calls = [await call(account.id, m3.id, 1, "personal", false), await call(account.id, m3.id, 2, "work", true)];
    await connection(account.id, m3.id, 0, encrypt(`cmr-a1-${TAG}`));
    secrets.push(`cmr-a1-${TAG}`);
    await pool.query(`create function ${trig}() returns trigger language plpgsql as $$ begin raise exception 'check-member-removal: injected failure'; end $$`);
    await pool.query(`create trigger ${trig} before delete on calendar_connections for each row when (old.member_id = '${m3.id}') execute function ${trig}()`);
    const present = await n(`select count(*) as n from pg_trigger where tgname = $1`, [trig]);
    let threw = "";
    try {
      answer = () => json(200, {});
      seen.length = 0;
      try {
        await removeMember(m3.email);
      } catch (err) {
        threw = errText(err);
      }
      check("a1: with a failure injected at the transaction's last step, removeMember throws it and nothing is kept: still active, both calls, the calendar row, Google not asked",
        threw.includes("injected failure") && (await removedAt(m3.id)) === null && (await n(`select count(*) as n from recordings where id = any($1::uuid[])`, [calls])) === 2
          && (await connections(m3.id)) === 1 && seen.length === 0,
        `threw ${threw.slice(0, 200) || "(nothing)"}; removed_at ${await removedAt(m3.id)}; calls ${await n(`select count(*) as n from recordings where id = any($1::uuid[])`, [calls])}; rows ${await connections(m3.id)}; google ${seen.length}`);
    } finally {
      await pool.query(`drop trigger if exists ${trig} on calendar_connections`);
      await pool.query(`drop function if exists ${trig}()`);
    }
    const trigLeft = await n(`select count(*) as n from pg_trigger where tgname = $1`, [trig]);
    const fnLeft = await n(`select count(*) as n from pg_proc where proname = $1`, [trig]);
    console.log(`trigger ${trig}: before drop ${present} in pg_trigger; after drop ${trigLeft} in pg_trigger, ${fnLeft} in pg_proc`);
    check("a2: the trigger and its function are gone (pg_trigger had it before the drop)", present === 1 && trigLeft === 0 && fnLeft === 0, `before ${present}; after ${trigLeft}/${fnLeft}`);
    const r3 = (await removeMember(m3.email)).report;
    check("a3: control: with the trigger gone, the same removal completes: removed, both calls deleted, 0 rows, revoked",
      (await removedAt(m3.id)) !== null && r3.deleted.recordings === 2 && r3.deleted.personal === 1 && r3.deleted.trashed === 1
        && (await connections(m3.id)) === 0 && r3.calendar.google[0]?.outcome === "revoked",
      JSON.stringify(r3));
  } finally {
    await pool.query(`drop trigger if exists ${trig} on calendar_connections`);
    await pool.query(`drop function if exists ${trig}()`);
    if (made.length > 0) {
      await db.transaction(async (tx) => {
        await deleteRecordings(tx, account.id, inArray(schema.recordings.ownerMemberId, made));
      });
      await db.delete(schema.calendarConnections).where(inArray(schema.calendarConnections.memberId, made));
      await db.delete(schema.accountMembers).where(inArray(schema.accountMembers.id, made));
    }
    console.log(`cleanup: members left ${await n(`select count(*) as n from account_members where id = any($1::uuid[])`, [made])}`);
  }
  console.log(`check-member-removal: ${passes} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  })
  .finally(endPool);
