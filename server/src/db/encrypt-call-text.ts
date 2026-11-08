// The backfill for call text at rest (SAA-277 step 6): encrypts the call text that
// rows written before step 2 still hold in plain, with CALL_TEXT_KEY.
//
//   npx tsx src/db/encrypt-call-text.ts            dry run: counts only, writes nothing
//   npx tsx src/db/encrypt-call-text.ts --apply    encrypts, in batches, then reads back
//   … --batch=<n>                                  rows per batch (default 500)
//   built: node dist/db/encrypt-call-text.js [--apply]   (on the host, where the key is)
//
// What it covers is what the schema seals (db/call-text-columns.ts): seven text
// columns, moments.metadata span_label and speakers, and recordings.metadata
// capture_quality.dropped_segments[].text. "Plain" is decided in SQL by the same
// shape lib/call-text.ts tests (cw1:<8 hex>:<base64>) and the same conditions the
// seal functions use, so a value is plain here exactly when the ORM would seal it.
//
// Two refusals on --apply, before anything is written:
//   - CALL_TEXT_KEY_ID must be set and be the loaded key's id, so the key is the
//     one the operator meant (scratch-db.sh sets the branch's test key's id; on
//     the host it is fly.toml's);
//   - no value already encrypted may be under another key id: one key per
//     database until rotation exists. The ids found are printed, never values.
//
// Safe beside a running server. Each batch is one UPDATE whose rows are matched on
// their id AND the value read: a row the server changed in between is not written
// over, it is counted as a conflict, and the next sweep reads it again. Sweeps
// repeat until nothing plain is left, or a sweep makes no progress (then it stops
// and says so). A value already encrypted is never selected, so a second run
// changes nothing. updated_at is not touched: the content is the same.
//
// It prints counts, key ids and the ids of rows that conflicted. Never text. It
// ends with the readback: what is still plain, per column and field, which must
// be 0 everywhere after --apply (exit 1 otherwise; a refusal is exit 2).

import { pathToFileURL } from "node:url";
import { CallTextKeyError, decryptCallText, encryptCallText, loadCallTextKey, type CallTextKey } from "../lib/call-text.js";
import { sealMomentMetadata, sealRecordingMetadata } from "./call-text-columns.js";

// The shape lib/call-text.ts's STORED tests, as a POSIX regex for Postgres. The
// key id is the 8 characters after "cw1:" (substring from 5 for 8).
export const ENCRYPTED_RE = "^cw1:[0-9a-f]{8}:[A-Za-z0-9+/]+={0,2}$";

type Queryable = { query: <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> };

export type Target = {
  label: string;
  table: string;
  column: string;
  kind: "text" | "jsonb";
  // A boolean SQL expression, true when the row holds call text in plain here.
  // $1 is ENCRYPTED_RE.
  plain: string;
  // A query for the distinct key ids of the values already encrypted here, as
  // column kid. $1 is ENCRYPTED_RE.
  keyIds: string;
  // The new stored value, from the old one (as Postgres gave it as text).
  seal: (old: string, key: CallTextKey) => string;
};

const textTarget = (table: string, column: string): Target => ({
  label: `${table}.${column}`,
  table,
  column,
  kind: "text",
  plain: `${column} is not null and ${column} !~ $1`,
  keyIds: `select distinct substring(${column} from 5 for 8) kid from ${table} where ${column} ~ $1`,
  seal: (old, key) => encryptCallText(old, key),
});

const DROPPED = `case when jsonb_typeof(metadata->'capture_quality'->'dropped_segments') = 'array'
                      then metadata->'capture_quality'->'dropped_segments' else '[]'::jsonb end`;

export const TARGETS: Target[] = [
  textTarget("recordings", "title"),
  textTarget("transcripts", "text"),
  textTarget("segments", "text"),
  textTarget("moments", "title"),
  textTarget("moments", "summary"),
  textTarget("clips", "title"),
  textTarget("clips", "description"),
  {
    label: "moments.metadata (span_label, speakers)",
    table: "moments",
    column: "metadata",
    kind: "jsonb",
    plain: `jsonb_typeof(metadata) = 'object' and (
      (jsonb_typeof(metadata->'span_label') = 'string' and metadata->>'span_label' !~ $1)
      or (metadata ? 'speakers' and jsonb_typeof(metadata->'speakers') <> 'null'
          and not (jsonb_typeof(metadata->'speakers') = 'string' and metadata->>'speakers' ~ $1)))`,
    keyIds: `select distinct substring(v from 5 for 8) kid from (
      select metadata->>'span_label' v from moments where jsonb_typeof(metadata->'span_label') = 'string'
      union all
      select metadata->>'speakers' v from moments where jsonb_typeof(metadata->'speakers') = 'string') x
      where v ~ $1`,
    seal: (old, key) => JSON.stringify(sealMomentMetadata(JSON.parse(old), key)),
  },
  {
    label: "recordings.metadata (dropped_segments text)",
    table: "recordings",
    column: "metadata",
    kind: "jsonb",
    plain: `jsonb_typeof(metadata->'capture_quality') = 'object'
      and jsonb_typeof(metadata->'capture_quality'->'dropped_segments') = 'array'
      and exists (select 1 from jsonb_array_elements(metadata->'capture_quality'->'dropped_segments') e
                  where jsonb_typeof(e) = 'object' and jsonb_typeof(e->'text') = 'string' and e->>'text' !~ $1)`,
    keyIds: `select distinct substring(e->>'text' from 5 for 8) kid
      from recordings, jsonb_array_elements(${DROPPED}) e
      where jsonb_typeof(e) = 'object' and jsonb_typeof(e->'text') = 'string' and e->>'text' ~ $1`,
    seal: (old, key) => JSON.stringify(sealRecordingMetadata(JSON.parse(old), key)),
  },
];

export async function countPlain(db: Queryable, t: Target): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int n from ${t.table} where ${t.plain}`, [ENCRYPTED_RE]);
  return r.rows[0].n;
}

// Every key id the encrypted values in the database are under, sorted.
export async function keyIdsInUse(db: Queryable): Promise<string[]> {
  const ids = new Set<string>();
  for (const t of TARGETS) for (const r of (await db.query<{ kid: string }>(t.keyIds, [ENCRYPTED_RE])).rows) ids.add(r.kid);
  return [...ids].sort();
}

export type Readback = Array<{ label: string; plain: number }>;
export async function readback(db: Queryable): Promise<Readback> {
  const out: Readback = [];
  for (const t of TARGETS) out.push({ label: t.label, plain: await countPlain(db, t) });
  return out;
}

// A refusal before anything is written; its message holds key ids, never a key
// or a value.
export class BackfillRefused extends Error {
  override name = "BackfillRefused";
}

export type TargetResult = { label: string; plainBefore: number; encrypted: number; conflicts: number; batches: number; sweeps: number; stoppedWithoutProgress: boolean };

export type BackfillOptions = {
  apply: boolean;
  batchSize?: number;
  key?: CallTextKey;
  // The id the key must have for --apply; CALL_TEXT_KEY_ID when not given.
  expectedKeyId?: string;
  log?: (line: string) => void;
  // For checks: called with each batch's ids after they are read and before they
  // are written, so a check can change a row in between, as the server might.
  beforeUpdate?: (t: Target, ids: string[]) => Promise<void>;
};

export async function backfill(db: Queryable, opts: BackfillOptions): Promise<{ results: TargetResult[]; readback: Readback }> {
  const key = opts.key ?? loadCallTextKey();
  const log = opts.log ?? ((l: string) => console.log(l));
  const batchSize = opts.batchSize ?? 500;
  log(`backfill: key ${key.id}, ${opts.apply ? `apply, batches of ${batchSize}` : "dry run (nothing written)"}`);

  const inUse = await keyIdsInUse(db);
  log(`backfill: key ids already in the database: ${inUse.length > 0 ? inUse.join(",") : "none"}`);
  if (opts.apply) {
    const expected = ("expectedKeyId" in opts ? opts.expectedKeyId : process.env.CALL_TEXT_KEY_ID)?.trim();
    if (!expected) throw new BackfillRefused(`refused: CALL_TEXT_KEY_ID is not set; --apply needs it to name the key meant (this key is ${key.id})`);
    if (expected !== key.id) throw new BackfillRefused(`refused: the key loaded is ${key.id}, but CALL_TEXT_KEY_ID names ${expected}`);
    const others = inUse.filter((id) => id !== key.id);
    if (others.length > 0) throw new BackfillRefused(`refused: values already encrypted under other key id(s) ${others.join(",")}; this key is ${key.id}`);
  }

  const results: TargetResult[] = [];
  for (const t of TARGETS) {
    const plainBefore = await countPlain(db, t);
    const res: TargetResult = { label: t.label, plainBefore, encrypted: 0, conflicts: 0, batches: 0, sweeps: 0, stoppedWithoutProgress: false };
    if (opts.apply && plainBefore > 0) {
      const conflictIds = new Set<string>();
      for (;;) {
        res.sweeps++;
        let sweepWrote = 0;
        let after: string | null = null;
        for (;;) {
          const batch: { rows: Array<{ id: string; v: string }> } = await db.query<{ id: string; v: string }>(
            `select id::text id, ${t.column}::text v from ${t.table} where (${t.plain})${after ? " and id > $3::uuid" : ""} order by id limit $2`,
            after ? [ENCRYPTED_RE, batchSize, after] : [ENCRYPTED_RE, batchSize],
          );
          if (batch.rows.length === 0) break;
          after = batch.rows[batch.rows.length - 1].id;
          res.batches++;
          const ids = batch.rows.map((r) => r.id);
          const olds = batch.rows.map((r) => r.v);
          const news = batch.rows.map((r) => t.seal(r.v, key));
          if (opts.beforeUpdate) await opts.beforeUpdate(t, ids);
          const type = t.kind === "text" ? "text" : "jsonb";
          const written = await db.query<{ id: string }>(
            `update ${t.table} as t set ${t.column} = v.new
               from unnest($1::uuid[], $2::${type}[], $3::${type}[]) as v(id, new, old)
              where t.id = v.id and t.${t.column} = v.old
             returning t.id::text id`,
            [ids, news, olds],
          );
          const done = new Set(written.rows.map((r) => r.id));
          for (const id of ids) if (!done.has(id)) conflictIds.add(id);
          res.encrypted += done.size;
          sweepWrote += done.size;
        }
        const left = await countPlain(db, t);
        if (left === 0) break;
        if (sweepWrote === 0) {
          res.stoppedWithoutProgress = true;
          break;
        }
      }
      res.conflicts = conflictIds.size;
      if (conflictIds.size > 0) log(`backfill: ${t.label} rows changed while read, read again: ids=${[...conflictIds].join(",")}`);
    }
    log(
      opts.apply
        ? `backfill: ${t.label} plain before=${plainBefore} encrypted=${res.encrypted} conflicts=${res.conflicts} batches=${res.batches} sweeps=${res.sweeps}${res.stoppedWithoutProgress ? " STOPPED: a sweep made no progress" : ""}`
        : `backfill: ${t.label} plain=${plainBefore}`,
    );
    results.push(res);
  }

  const rb = await readback(db);
  for (const r of rb) log(`readback: ${r.label} plain=${r.plain}`);
  const left = rb.reduce((n, r) => n + r.plain, 0);
  log(`readback: ${left === 0 ? "nothing plain left" : `${left} plain value(s) left`}`);
  return { results, readback: rb };
}

// ---- run as a script ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const bad = args.filter((a) => a !== "--apply" && !/^--batch=\d+$/.test(a));
  if (bad.length > 0) {
    console.error("usage: encrypt-call-text [--apply] [--batch=<rows>]");
    process.exit(2);
  }
  const apply = args.includes("--apply");
  const batchArg = args.find((a) => a.startsWith("--batch="));
  const batchSize = batchArg ? Number(batchArg.slice("--batch=".length)) : 500;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    console.error("encrypt-call-text: --batch must be a whole number of rows, 1 or more");
    process.exit(2);
  }
  const { pool } = await import("./index.js");
  let code = 0;
  try {
    const key = loadCallTextKey();
    // The key must open what it writes before anything is written.
    if (decryptCallText(encryptCallText("check", key), key) !== "check") throw new BackfillRefused("refused: the key does not round-trip");
    const { readback: rb } = await backfill(pool, { apply, batchSize, key });
    if (apply && rb.some((r) => r.plain > 0)) code = 1;
  } catch (err) {
    // A message is printed only for the two classes whose messages are known to
    // hold ids and variable names only. Anything else prints its class, and a
    // database error its code too: a database error's text can quote a row, and
    // a JSON.parse error quotes its input, which here is call text.
    const e = err as { code?: unknown; name?: unknown };
    const cls = err instanceof Error ? err.constructor.name : typeof err;
    if (err instanceof BackfillRefused) {
      console.error(`encrypt-call-text: ${err.message}`);
      code = 2;
    } else if (err instanceof CallTextKeyError) {
      console.error(`encrypt-call-text: failed: ${err.message}`);
      code = 1;
    } else if (typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
      console.error(`encrypt-call-text: failed: ${cls} (code ${e.code})`);
      code = 1;
    } else {
      console.error(`encrypt-call-text: failed: ${cls}`);
      code = 1;
    }
  } finally {
    await pool.end();
  }
  process.exit(code);
}
