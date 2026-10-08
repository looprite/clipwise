// Applies the CHECK constraints that src/db/schema.ts declares.
//
// Why this exists: drizzle-kit 0.24 `push` neither created CHECK constraints
// nor noticed that they were missing — with recordings_scope_valid and
// shares_target_exactly_one absent from a database it reported "No changes
// detected". Main has them only because an older migration ran there once, so
// a database built by `db:push` alone lacked every check the schema declares.
// drizzle-kit 0.31 push creates them itself, so on a current kit this normally
// finds nothing to add ("N present, 0 added"). It stays as a guard: it reads
// the checks off the schema (nothing is listed by hand) and adds any that are
// missing, so a kit that stopped creating them again would show up here
// instead of as a database that quietly accepts bad values.
//
// Idempotent: a check that already exists by name is left alone. Adding one
// validates existing rows, so a row that violates it makes this fail loudly
// rather than weaken the constraint.
//
// Usage:
//   tsx src/db/checks.ts          add missing checks
//   tsx src/db/checks.ts --dry    list what would be added, change nothing

import { is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { pool } from "./index.js";
import * as schema from "./schema.js";

type Wanted = { table: string; name: string; expr: string };

export function declaredChecks(): Wanted[] {
  const dialect = new PgDialect();
  const out: Wanted[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    for (const c of cfg.checks) {
      // Column references render table-qualified ("recordings"."scope");
      // inside a CHECK on that same table the qualifier is redundant.
      const { sql: raw } = dialect.sqlToQuery(c.value);
      const expr = raw.split(`"${cfg.name}".`).join("");
      out.push({ table: cfg.name, name: c.name, expr });
    }
  }
  return out;
}

export async function ensureChecks(dry = false): Promise<{ added: Wanted[]; present: number }> {
  const wanted = declaredChecks();
  const { rows } = await pool.query<{ conname: string }>(
    `select co.conname from pg_constraint co
       join pg_class cl on cl.oid = co.conrelid
       join pg_namespace ns on ns.oid = cl.relnamespace
      where ns.nspname = 'public' and co.contype = 'c'`,
  );
  const have = new Set(rows.map((r) => r.conname));
  const added: Wanted[] = [];
  for (const w of wanted) {
    if (have.has(w.name)) continue;
    if (!dry) {
      await pool.query(`ALTER TABLE "${w.table}" ADD CONSTRAINT "${w.name}" CHECK (${w.expr})`);
    }
    added.push(w);
  }
  return { added, present: wanted.length - added.length };
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const { added, present } = await ensureChecks(dry);
  const verb = dry ? "would add" : "added";
  process.stdout.write(`db-checks: ${present} already present, ${verb} ${added.length}\n`);
  for (const a of added) process.stdout.write(`db-checks:   ${a.table}.${a.name}  CHECK (${a.expr})\n`);
}

// Run directly (tsx src/db/checks.ts), not when imported by provision.ts.
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
    .catch((err) => {
      process.stderr.write(`db-checks: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
