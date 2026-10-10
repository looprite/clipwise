// Check for the unique index recordings_account_source_idx on
// (account_id, source, source_id), run against a scratch branch (with main's rows
// when the point is to see the push on real data).
//
//  1. Reads the index back through pg_indexes: it exists and is UNIQUE on those
//     three columns, in that order.
//  2. Takes an existing recording and, in a transaction that is always rolled
//     back, inserts a copy with a new slug and the same (account_id, source,
//     source_id): SQLSTATE 23505 on recordings_account_source_idx is expected.
//  3. Positive control: the same insert with a different source_id succeeds (so
//     the 23505 above came from the index and not from the slug or another
//     constraint).
//  4. The row count is the same afterwards: nothing was written.
//
// Usage: scratch-db.sh run check-unique-index      (before the push it must FAIL)

import { randomUUID } from "node:crypto";
import { pool } from "./index.js";

if (process.env.CLIPWISE_CHECK_SCRATCH_DB !== "1") {
  process.stderr.write("check-unique-index: refusing to run — use scratch-db.sh run check-unique-index.\n");
  process.exit(2);
}

let failed = 0;
let total = 0;
function check(ok: boolean, name: string, detail = ""): void {
  total++;
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function count(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("select count(*)::text as n from recordings");
  return Number(rows[0].n);
}

async function main(): Promise<void> {
  const before = await count();
  process.stdout.write(`rows in recordings: ${before}\n`);

  const { rows: idx } = await pool.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'recordings' and indexname = 'recordings_account_source_idx'",
  );
  process.stdout.write(`pg_indexes: ${idx.length ? idx[0].indexdef : "(no row)"}\n`);
  check(
    idx.length === 1 && /^CREATE UNIQUE INDEX recordings_account_source_idx ON public\.recordings USING btree \(account_id, source, source_id\)$/.test(idx[0].indexdef),
    "recordings_account_source_idx is a UNIQUE btree index on (account_id, source, source_id)",
  );

  const { rows: pick } = await pool.query<{ id: string; account_id: string; source: string; source_id: string }>(
    "select id, account_id, source, source_id from recordings where account_id is not null and source is not null and source_id is not null order by created_at limit 1",
  );
  if (pick.length === 0) {
    check(false, "there is a recording to duplicate", "recordings is empty (use a branch made with --with-data)");
    return;
  }
  const r = pick[0];

  const client = await pool.connect();
  try {
    // Duplicate: expect 23505 on the index.
    await client.query("begin");
    let code = "none";
    let constraint = "";
    try {
      await client.query("insert into recordings (account_id, slug, source, source_id) values ($1, $2, $3, $4)", [
        r.account_id,
        `check-dup-${randomUUID()}`,
        r.source,
        r.source_id,
      ]);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      code = e.code ?? "?";
      constraint = e.constraint ?? "";
    }
    await client.query("rollback");
    check(code === "23505" && constraint === "recordings_account_source_idx", "a duplicate (account_id, source, source_id) is refused", `SQLSTATE ${code}, constraint ${constraint || "-"}`);

    // Positive control: a different source_id is accepted.
    await client.query("begin");
    let ok = false;
    try {
      await client.query("insert into recordings (account_id, slug, source, source_id) values ($1, $2, $3, $4)", [
        r.account_id,
        `check-ok-${randomUUID()}`,
        r.source,
        `${r.source_id}-check-${randomUUID()}`,
      ]);
      ok = true;
    } catch {
      ok = false;
    }
    await client.query("rollback");
    check(ok, "control: the same insert with a different source_id is accepted (then rolled back)");
  } finally {
    client.release();
  }

  const after = await count();
  check(after === before, "nothing was written", `rows ${before} -> ${after}`);
}

main()
  .catch((err) => {
    process.stderr.write(`check-unique-index: ${err instanceof Error ? err.message : String(err)}\n`);
    failed++;
  })
  .finally(async () => {
    process.stdout.write(`\n${total - failed}/${total} passed\n`);
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  });
