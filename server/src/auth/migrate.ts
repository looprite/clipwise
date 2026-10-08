// Creates and upgrades Better Auth's own tables (auth_user, auth_session, the
// OAuth and key tables). drizzle-kit never sees them: drizzle.config.ts only
// lets it touch the tables src/db/schema.ts declares, so `db:push` cannot
// propose dropping these.
//
// Usage:
//   tsx src/auth/migrate.ts          plan, then apply
//   tsx src/auth/migrate.ts --plan   print the plan and change nothing
//
// Exit 0 on success. A plan that Better Auth marks unsafe (a required column
// with no default on a populated table) or a schema problem is a failure.

import { pool } from "../db/index.js";
import { getAuth } from "./auth.js";
import { getMigrations } from "better-auth/db/migration";

async function main(): Promise<void> {
  const planOnly = process.argv.includes("--plan");
  const { toBeCreated, toBeAdded, toBeAddedIndexes, unsafeChanges, schemaProblems, runMigrations } =
    await getMigrations(getAuth().options, { throwOnUnsafe: false });

  const line = (s: string) => process.stdout.write(`auth-migrate: ${s}\n`);
  line(`tables to create: ${toBeCreated.map((t) => t.table).join(", ") || "(none)"}`);
  line(
    `columns to add:   ${toBeAdded.map((t) => `${t.table}(${Object.keys(t.fields).join(",")})`).join("; ") || "(none)"}`,
  );
  line(`indexes to add:   ${toBeAddedIndexes.map((i) => i.name).join(", ") || "(none)"}`);
  for (const u of unsafeChanges) line(`UNSAFE: ${u}`);
  for (const p of schemaProblems) line(`PROBLEM: ${p}`);
  if (unsafeChanges.length || schemaProblems.length) {
    process.exitCode = 1;
    return;
  }
  if (planOnly) return;

  await runMigrations();
  line("applied");
}

main()
  .catch((err) => {
    process.stderr.write(`auth-migrate: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
