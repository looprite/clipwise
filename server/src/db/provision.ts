// Builds a new instance's database from nothing:
//   1. CREATE EXTENSION vector      (schema.ts needs pgvector before any table)
//   2. drizzle-kit push             (the tables schema.ts declares)
//   3. the CHECK constraints        (push does not create them — see checks.ts)
//   4. Better Auth's tables         (src/auth/migrate.ts)
// then `tsx src/auth/cli.ts init-account` and `bootstrap-admin` make the first
// account and admin.
//
// This is the architecture-decision-10 path (push, not committed migrations),
// made repeatable. It refuses any database that already has tables: step 2
// runs with --force so it can run unattended, and --force also auto-approves
// destructive statements, which is only safe against an empty database. To
// bring an existing database up to date use `npm run db:sync` instead, which
// keeps push's confirmation prompt.
//
// Point DATABASE_URL at a direct (non-pooled) connection for this.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { pool } from "./index.js";
import { ensureChecks } from "./checks.js";
import { getAuth } from "../auth/auth.js";

const say = (s: string) => process.stdout.write(`db-provision: ${s}\n`);

async function main(): Promise<void> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
  );
  const existing = Number(rows[0].n);
  if (existing > 0) {
    throw new Error(
      `database already has ${existing} table(s) in public. Provisioning is for an empty database; ` +
        `use "npm run db:sync" to update an existing one.`,
    );
  }

  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  say("pgvector ready");

  const kit = resolve(import.meta.dirname, "..", "..", "node_modules", ".bin", "drizzle-kit");
  execFileSync(kit, ["push", "--force"], { stdio: "inherit", cwd: resolve(import.meta.dirname, "..", "..") });
  say("tables pushed");

  const checks = await ensureChecks();
  say(`checks: ${checks.present} present, ${checks.added.length} added`);

  const { runMigrations } = await getMigrations(getAuth().options);
  await runMigrations();
  say("auth tables created");

  const { rows: after } = await pool.query<{ n: string }>(
    `select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
  );
  say(`done: ${after[0].n} tables in public`);
}

main()
  .catch((err) => {
    process.stderr.write(`db-provision: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
