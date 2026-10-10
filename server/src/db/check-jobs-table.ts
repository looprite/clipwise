// Reads the jobs table back from the database after a schema push (SAA-227 D1),
// through pg_indexes, pg_constraint and information_schema, and tries the partial
// unique index: while a job is queued or running a second one for the same
// recording and kind is refused; once it is done or failed another may be made;
// another kind or another recording is never refused.
//
//   scripts/scratch-db.sh run check-jobs-table

import { randomUUID } from "node:crypto";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { pool } from "./index.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-jobs-table");

  const idx = await pool.query("select indexname, indexdef from pg_indexes where tablename = 'jobs' order by indexname");
  console.log("pg_indexes for jobs:");
  for (const r of idx.rows) console.log(`  ${r.indexname}: ${r.indexdef}`);
  const active = idx.rows.find((r) => r.indexname === "jobs_active_recording_kind_idx");
  check(
    "the partial unique index exists on (recording_id, kind) where state in ('queued','running')",
    !!active &&
      /CREATE UNIQUE INDEX/i.test(active.indexdef) &&
      /\(recording_id, kind\)/.test(active.indexdef) &&
      /WHERE .*state.*queued.*running/i.test(active.indexdef),
    active?.indexdef ?? "no such index",
  );

  const cols = await pool.query(
    "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'jobs' order by ordinal_position",
  );
  console.log("columns:");
  for (const c of cols.rows) console.log(`  ${c.column_name} ${c.data_type} nullable=${c.is_nullable} default=${c.column_default ?? "-"}`);
  const names = cols.rows.map((c) => c.column_name as string);
  const want = ["id", "account_id", "recording_id", "kind", "state", "attempts", "run_after", "lease_token", "lease_expires_at", "run_ids", "error_class", "last_error", "created_at", "started_at", "finished_at", "updated_at"];
  check("the columns are exactly the declared ones", JSON.stringify(names) === JSON.stringify(want), names.join(","));

  const cons = await pool.query("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'jobs'::regclass order by conname");
  console.log("constraints:");
  for (const c of cons.rows) console.log(`  ${c.conname}: ${c.def}`);
  check("kind and state have their CHECK constraints", cons.rows.some((c) => c.conname === "jobs_kind_valid") && cons.rows.some((c) => c.conname === "jobs_state_valid"));

  const fx = await makeAccount("check-jobs-table");
  try {
    const a = await makeRecording(fx, { segments: 1 });
    const b = await makeRecording(fx, { segments: 1 });
    const ins = async (rec: string, kind: string, state: string): Promise<string> => {
      try {
        await pool.query("insert into jobs (id, account_id, recording_id, kind, state) values ($1, $2, $3, $4, $5)", [randomUUID(), fx.accountId, rec, kind, state]);
        return "inserted";
      } catch (e) {
        return `refused ${(e as { code?: string; constraint?: string }).code} ${(e as { constraint?: string }).constraint ?? ""}`.trim();
      }
    };
    check("a first queued job is accepted", (await ins(a, "extract", "queued")) === "inserted");
    const dup = await ins(a, "extract", "queued");
    check("a second queued job for the same recording and kind is refused by the index", dup === "refused 23505 jobs_active_recording_kind_idx", dup);
    const dupRunning = await ins(a, "extract", "running");
    check("so is a running one", dupRunning === "refused 23505 jobs_active_recording_kind_idx", dupRunning);
    check("another kind on the same recording is accepted", (await ins(a, "re_extract", "queued")) === "inserted");
    check("the same kind on another recording is accepted", (await ins(b, "extract", "queued")) === "inserted");
    check("done jobs do not count: two done for one recording and kind are accepted", (await ins(a, "extract", "done")) === "inserted" && (await ins(a, "extract", "done")) === "inserted");
    check("failed jobs do not count either", (await ins(a, "extract", "failed")) === "inserted");
    await pool.query("update jobs set state = 'done' where recording_id = $1 and kind = 'extract' and state = 'queued'", [a]);
    check("once the queued one is done another may be queued", (await ins(a, "extract", "queued")) === "inserted");
    const badKind = await ins(a, "nonsense", "queued");
    check("an unknown kind is refused by the CHECK", badKind === "refused 23514 jobs_kind_valid", badKind);
    const badState = await ins(b, "re_extract", "paused");
    check("an unknown state is refused by the CHECK", badState === "refused 23514 jobs_state_valid", badState);
    await pool.query("delete from recordings where id = $1", [b]);
    const orphans = await pool.query("select count(*)::int as n from jobs where recording_id = $1", [b]);
    check("deleting a recording deletes its jobs", orphans.rows[0].n === 0);
  } finally {
    await dropAccount(fx);
    await endPool();
  }
  console.log(failures === 0 ? "\ncheck-jobs-table: all passed" : `\ncheck-jobs-table: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`check-jobs-table: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
