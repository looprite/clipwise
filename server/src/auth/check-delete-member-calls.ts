// Check for delete-member-calls (SAA-289): the host's command that permanently
// deletes a removed member's calls. Real database, the real CLI as a child
// process, in the scratch instance's one account (the CLI requires exactly one).
//
// Two members, A and B, each with three recordings (work private, personal
// trashed, work shared), and under each a transcript, speakers, segments,
// moments, a clip, a share of the clip and one of the recording, attendees,
// an invitee and a job. A person only A's calls name, one only B's name, and
// one both name. Every segment and moment summary carries a phrase made for
// this run.
//
//   v0  the count query finds rows in every table for A's recordings and for
//       B's before anything is deleted (validates the query)
//   v1  the phrase is in A's segment text, read back through the ORM (control
//       for t1)
//   f0  deleteRecordings with no filter throws, and every count is unchanged
//   r0  an unknown email is refused, counts unchanged
//   a   A, not removed, is refused, counts unchanged
//   d0  after remove-member, a dry run deletes nothing and says what --apply
//       would delete
//   b   --apply: a query by owner finds 0 recordings for A, and 0 rows in every
//       table found from pg_constraint for A's recording ids; the person only
//       A's calls named is gone, the shared one stays
//   c   B's counts are unchanged (control)
//   d   a second --apply deletes nothing and says "nothing to delete"
//   t1  no output of the command carries the phrase; the log line is ids and
//       counts only
//
// The tables are found, not listed: every foreign key in pg_constraint that
// points at recordings, or at a table found that way (as check-access 18f).
//
//   scripts/scratch-db.sh run check-delete-member-calls

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { inArray, type SQL } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { deleteRecordings } from "../db/delete-recordings.js";
import { endPool, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { requireAccount } from "./members.js";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (ok) passes++;
  else failures++;
}

const SERVER_DIR = resolve(import.meta.dirname, "..", "..");
const TAG = randomUUID().slice(0, 8);
const PHRASE = `quince harbour ${TAG}`;

type Run = { status: number | null; out: string };
const outputs: string[] = [];
function cli(...args: string[]): Run {
  const r = spawnSync("npx", ["--no-install", "tsx", "src/auth/cli.ts", ...args], {
    cwd: SERVER_DIR,
    env: process.env,
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  outputs.push(out);
  return { status: r.status, out };
}

// Every foreign key into recordings, directly or through a table found that way.
type Edge = { table: string; column: string; parent: string; parentColumn: string };
async function edgesIntoRecordings(): Promise<{ tables: string[]; edges: Edge[]; pk: Record<string, string> }> {
  const fks = (
    await pool.query(
      `select c.conrelid::regclass::text as table, a.attname as column, c.confrelid::regclass::text as parent, pa.attname as parent_column
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
    )
  ).rows.map((r): Edge => ({ table: r.table, column: r.column, parent: r.parent, parentColumn: r.parent_column }));
  const tables = ["recordings"];
  const edges: Edge[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of fks) {
      if (!tables.includes(e.parent) || edges.some((x) => x.table === e.table && x.column === e.column)) continue;
      edges.push(e);
      if (!tables.includes(e.table)) tables.push(e.table);
      grew = true;
    }
  }
  const pk: Record<string, string> = {};
  for (const t of tables) {
    const rows = (await pool.query(`select a.attname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) where c.contype = 'p' and c.conrelid = $1::regclass`, [t])).rows;
    pk[t] = rows[0].attname;
  }
  return { tables, edges, pk };
}

// Rows in each table found that belong to these recordings.
async function countsFor(g: Awaited<ReturnType<typeof edgesIntoRecordings>>, recordingIds: string[]): Promise<Record<string, number>> {
  const ids: Record<string, Set<string>> = { recordings: new Set() };
  if (recordingIds.length > 0) {
    const r = await pool.query(`select id from recordings where id = any($1::uuid[])`, [recordingIds]);
    for (const x of r.rows) ids.recordings.add(String(x.id));
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of g.edges) {
      const parents = [...(ids[e.parent] ?? [])];
      if (parents.length === 0) continue;
      const r = await pool.query(`select ${g.pk[e.table]}::text as id from ${e.table} where ${e.column}::text = any($1::text[])`, [parents]);
      const set = (ids[e.table] ??= new Set());
      for (const x of r.rows) if (!set.has(x.id)) { set.add(x.id); grew = true; }
    }
  }
  return Object.fromEntries(g.tables.map((t) => [t.replace(/"/g, ""), ids[t]?.size ?? 0]));
}

const ownedBy = async (memberId: string): Promise<string[]> =>
  (await pool.query(`select id from recordings where owner_member_id = $1 order by id`, [memberId])).rows.map((r) => String(r.id));
const show = (c: Record<string, number>) => Object.entries(c).map(([t, n]) => `${t}=${n}`).join(" ");
const same = (x: Record<string, number>, y: Record<string, number>) => JSON.stringify(x) === JSON.stringify(y);

async function person(accountId: string, name: string): Promise<string> {
  const [p] = await db.insert(schema.people).values({ accountId, name, email: `${name.toLowerCase().replace(/ /g, ".")}.${TAG}@clipwise.test` }).returning();
  return p.id;
}

async function call(
  accountId: string,
  memberId: string,
  n: number,
  o: { scope: "work" | "personal"; visibility: "private" | "shared"; trashed: boolean; people: string[] },
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.recordings).values({
    id, accountId, ownerMemberId: memberId, slug: `dmc-${TAG}-${id.slice(0, 8)}`, title: `check call ${n}`,
    source: "check", sourceId: id, status: "ready", scope: o.scope, visibility: o.visibility,
    trashedAt: o.trashed ? new Date() : null, metadata: {},
  });
  const [t] = await db.insert(schema.transcripts).values({ recordingId: id, provider: "check", language: "en", status: "ready" }).returning();
  const [me] = await db.insert(schema.speakers).values({ recordingId: id, label: "me" }).returning();
  const [them] = await db.insert(schema.speakers).values({ recordingId: id, label: "them", personId: o.people[0] }).returning();
  await db.insert(schema.segments).values(
    [0, 1, 2].map((i) => ({
      accountId, recordingId: id, transcriptId: t.id, speakerId: i % 2 === 0 ? me.id : them.id,
      startSec: i * 10, endSec: i * 10 + 9, text: `line ${i}: ${PHRASE}`, orderIndex: i,
    })),
  );
  const [m] = await db.insert(schema.moments).values({ accountId, recordingId: id, kind: "decision", title: "check moment", summary: `decided ${PHRASE}`, startSec: 0, endSec: 9 }).returning();
  const [clip] = await db.insert(schema.clips).values({ accountId, recordingId: id, momentId: m.id, createdBy: o.people[0], slug: `dmc-clip-${TAG}-${id.slice(0, 8)}`, startSec: 0, endSec: 9 }).returning();
  await db.insert(schema.shares).values([
    { accountId, clipId: clip.id, token: `dmc-c-${TAG}-${id}` },
    { accountId, recordingId: id, token: `dmc-r-${TAG}-${id}` },
  ]);
  await db.insert(schema.attendees).values(o.people.map((p, i) => ({ recordingId: id, personId: p, name: `Guest ${i}` })));
  await db.insert(schema.invitees).values({ recordingId: id, personId: o.people[0], email: `invitee.${TAG}.${id.slice(0, 8)}@clipwise.test` });
  await db.insert(schema.jobs).values({ accountId, recordingId: id, kind: "extract", state: "done" });
  return id;
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-delete-member-calls");
  const account = await requireAccount();
  const g = await edgesIntoRecordings();
  console.log(`tables found: ${g.tables.join(", ")}`);

  const emailA = `dmc-a-${TAG}@clipwise.test`;
  const emailB = `dmc-b-${TAG}@clipwise.test`;
  const [a] = await db.insert(schema.accountMembers).values({ accountId: account.id, email: emailA, role: "member", joinedAt: new Date() }).returning();
  const [b] = await db.insert(schema.accountMembers).values({ accountId: account.id, email: emailB, role: "member", joinedAt: new Date() }).returning();
  const onlyA = await person(account.id, "Ana Only");
  const onlyB = await person(account.id, "Ben Only");
  const both = await person(account.id, "Bea Both");
  const peopleIds = [onlyA, onlyB, both];
  const kinds = [
    { scope: "work", visibility: "private", trashed: false },
    { scope: "personal", visibility: "private", trashed: true },
    { scope: "work", visibility: "shared", trashed: false },
  ] as const;
  for (const [i, k] of kinds.entries()) {
    await call(account.id, a.id, i, { ...k, people: [onlyA, both] });
    await call(account.id, b.id, i, { ...k, people: [onlyB, both] });
  }
  const recA = await ownedBy(a.id);
  const recB = await ownedBy(b.id);
  const peopleLeft = async () =>
    new Set((await pool.query(`select id from people where id = any($1::uuid[])`, [peopleIds])).rows.map((r) => String(r.id)));

  try {
    const beforeA = await countsFor(g, recA);
    const beforeB = await countsFor(g, recB);
    console.log(`before, A: ${show(beforeA)}`);
    console.log(`before, B: ${show(beforeB)}`);
    check("v0: before anything is deleted, the count query finds rows in every table found, for A's recordings and for B's",
      Object.values(beforeA).every((n) => n > 0) && Object.values(beforeB).every((n) => n > 0), `A: ${show(beforeA)}; B: ${show(beforeB)}`);

    const segText = (await db.select({ text: schema.segments.text }).from(schema.segments).where(inArray(schema.segments.recordingId, recA))).map((s) => String(s.text)).join("\n");
    const controlHits = segText.split(PHRASE).length - 1;
    check("v1: control — the phrase is found in A's segment text read back through the ORM", controlHits > 0, `hits ${controlHits}`);

    let threw = "";
    try {
      await db.transaction(async (tx) => {
        await deleteRecordings(tx, account.id, undefined as unknown as SQL);
      });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check("f0: deleteRecordings without a filter throws, and every count is unchanged",
      threw.includes("a filter is required") && same(await countsFor(g, recA), beforeA) && same(await countsFor(g, recB), beforeB), `threw: ${threw || "(nothing)"}`);

    const r0 = cli("delete-member-calls", "--email", `dmc-nobody-${TAG}@clipwise.test`, "--apply");
    check("r0: an unknown email is refused (exit 1, \"is not a member\"), and every count is unchanged",
      r0.status === 1 && r0.out.includes("is not a member") && same(await countsFor(g, recA), beforeA) && same(await countsFor(g, recB), beforeB), `exit ${r0.status}: ${r0.out.trim()}`);

    const ra = cli("delete-member-calls", "--email", emailA, "--apply");
    check("a: A, not removed, is refused (exit 1, \"has not been removed\"), and every count is unchanged",
      ra.status === 1 && ra.out.includes("has not been removed") && same(await countsFor(g, recA), beforeA) && same(await countsFor(g, recB), beforeB), `exit ${ra.status}: ${ra.out.trim()}`);

    const rm = cli("remove-member", "--email", emailA);
    check("remove-member removes A", rm.status === 0 && rm.out.includes(`removed: ${emailA}`), `exit ${rm.status}: ${rm.out.trim()}`);

    const dry = cli("delete-member-calls", "--email", emailA);
    console.log(dry.out.trimEnd());
    check("d0: without --apply nothing is deleted, the run says what --apply would delete, and every count is unchanged",
      dry.status === 0 && dry.out.includes("nothing changed") && dry.out.includes(`recordings=${recA.length}`) && same(await countsFor(g, recA), beforeA) && same(await countsFor(g, recB), beforeB), `exit ${dry.status}`);

    const run = cli("delete-member-calls", "--email", emailA, "--apply");
    console.log(run.out.trimEnd());
    const afterA = await countsFor(g, recA);
    const ownedA = await ownedBy(a.id);
    console.log(`after, A's recording ids: ${show(afterA)}; by owner: ${ownedA.length}`);
    const left = await peopleLeft();
    check("b: --apply exits 0; a query by owner finds 0 recordings for A, and every table found has 0 rows for A's recording ids",
      run.status === 0 && ownedA.length === 0 && Object.values(afterA).every((n) => n === 0), `exit ${run.status}; owner ${ownedA.length}; ${show(afterA)}`);
    check("b: the person only A's calls named is deleted; the one B's calls also name, and B's own, stay",
      !left.has(onlyA) && left.has(both) && left.has(onlyB), `left: ${[...left].join(", ")}`);

    const afterB = await countsFor(g, recB);
    console.log(`after, B: ${show(afterB)}`);
    check("c: control — B's counts are unchanged", same(afterB, beforeB), `before ${show(beforeB)}; after ${show(afterB)}`);

    const again = cli("delete-member-calls", "--email", emailA, "--apply");
    console.log(again.out.trimEnd());
    check("d: a second --apply exits 0, says \"nothing to delete\", and deletes nothing",
      again.status === 0 && again.out.includes("nothing to delete") && (await ownedBy(a.id)).length === 0 && same(await countsFor(g, recB), beforeB), `exit ${again.status}: ${again.out.trim()}`);

    const all = outputs.join("\n");
    const hits = all.split(PHRASE).length - 1;
    check("t1: no output of the command carries the phrase in the call text (the same grep finds it in the segment text: v1)", hits === 0 && controlHits > 0, `hits ${hits}`);
    const logLines = all.split("\n").filter((l) => l.startsWith("delete-member-calls:"));
    const shape = /^delete-member-calls: member=[0-9a-f-]{36} recordings=\d+ people_released=\d+ applied=(true|false) at=\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
    check("t1: every log line is a member uuid, counts, applied and a time: no email, no name, no text",
      logLines.length >= 3 && logLines.every((l) => shape.test(l)), logLines.join(" | "));
  } finally {
    await db.transaction(async (tx) => {
      await deleteRecordings(tx, account.id, inArray(schema.recordings.ownerMemberId, [a.id, b.id]));
    });
    await db.delete(schema.people).where(inArray(schema.people.id, peopleIds));
    await db.delete(schema.accountMembers).where(inArray(schema.accountMembers.id, [a.id, b.id]));
    const leftover = (await pool.query(`select count(*)::int as n from account_members where id = any($1::uuid[])`, [[a.id, b.id]])).rows[0].n;
    console.log(`cleanup: members left ${leftover}`);
  }
  console.log(`check-delete-member-calls: ${passes} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  })
  .finally(endPool);
