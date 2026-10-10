// Seeing and retrying the jobs worker's jobs (SAA-227 decision 6). The recorder's
// tray shows them later (H); until then, this.
//
//   tsx src/jobs/cli.ts list [--limit N]
//   tsx src/jobs/cli.ts retry <job id>
//
// list prints one line per job, newest first (50 unless --limit): its id, the
// recording's id, kind, state, attempts, the error's class, and its times. Ids,
// states, counts and times only: no title, name, transcript text or error text,
// which can quote a call.
//
// retry puts a failed job back in the queue with its attempts at 0. It refuses a
// job that is not failed, an id with no job, and a recording that already has an
// active job of that kind. The running server is not told: the job runs when its
// worker next looks at the table (its next start, or the next capture stored).
//
// Exit code 0 on success, 1 on a refusal or failure; messages say which.

import { parseArgs } from "node:util";
import { pool } from "../db/index.js";

class Refusal extends Error {}

const say = (s: string) => process.stdout.write(`jobs: ${s}\n`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const at = (t: Date | null): string => (t ? t.toISOString() : "-");

type Row = {
  id: string;
  recording_id: string;
  kind: string;
  state: string;
  attempts: number;
  error_class: string | null;
  created_at: Date;
  run_after: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

async function list(limitArg: string | undefined): Promise<void> {
  const limit = limitArg === undefined ? 50 : Number(limitArg);
  if (!Number.isInteger(limit) || limit < 1) throw new Refusal("--limit must be a whole number above 0");
  const r = await pool.query<Row>(
    `select id, recording_id, kind, state, attempts, error_class, created_at, run_after, started_at, finished_at
     from jobs order by created_at desc, id limit $1`,
    [limit],
  );
  const total = (await pool.query<{ n: number }>("select count(*)::int as n from jobs")).rows[0].n;
  say(`${r.rows.length} of ${total} job(s), newest first`);
  for (const j of r.rows) {
    const when = j.state === "queued" ? `run_after=${at(j.run_after)}` : `started=${at(j.started_at)} finished=${at(j.finished_at)}`;
    process.stdout.write(
      `  ${j.id} recording=${j.recording_id} ${j.kind.padEnd(10)} ${j.state.padEnd(7)} attempts=${j.attempts} error=${j.error_class ?? "-"} created=${at(j.created_at)} ${when}\n`,
    );
  }
}

async function retry(id: string | undefined): Promise<void> {
  if (!id) throw new Refusal("usage: retry <job id>");
  if (!UUID.test(id)) throw new Refusal(`no job with id ${id}`);
  let r;
  try {
    r = await pool.query<{ recording_id: string; kind: string }>(
      `update jobs set state = 'queued', attempts = 0, run_after = now(), lease_token = null, lease_expires_at = null,
              error_class = null, last_error = null, started_at = null, finished_at = null, updated_at = now()
       where id = $1 and state = 'failed'
       returning recording_id, kind`,
      [id],
    );
  } catch (err) {
    // jobs_active_recording_kind_idx: one queued or running job per recording and kind.
    if ((err as { code?: string }).code === "23505") throw new Refusal(`job ${id} not retried: its recording already has a queued or running job of that kind`);
    throw err;
  }
  if (r.rowCount === 0) {
    const cur = await pool.query<{ state: string }>("select state from jobs where id = $1", [id]);
    if (cur.rows.length === 0) throw new Refusal(`no job with id ${id}`);
    throw new Refusal(`job ${id} is ${cur.rows[0].state}, not failed; only a failed job can be retried`);
  }
  say(`job ${id} recording=${r.rows[0].recording_id} kind=${r.rows[0].kind} failed→queued, attempts 0 (it runs when the server's worker next looks: its next start, or the next capture stored)`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { limit: { type: "string" } } });
  switch (command) {
    case "list":
      return list(values.limit);
    case "retry":
      return retry(positionals[0]);
    default:
      throw new Refusal("usage: list [--limit N] | retry <job id> (see the header of src/jobs/cli.ts)");
  }
}

main()
  .catch((err) => {
    process.stderr.write(`jobs: ${err instanceof Refusal ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
