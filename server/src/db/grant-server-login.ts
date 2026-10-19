// Gives the server's own login exactly the rights it needs on this database
// (SAA-243, decided 2026-10-18): read and write rows in every table in schema
// public, and nothing else. No CREATE, ALTER, DROP, TRUNCATE, REFERENCES or
// TRIGGER, no creating logins or databases. Tables the owner creates later get
// the same row rights through ALTER DEFAULT PRIVILEGES, so a schema push does
// not need this to be run again. USAGE on public is granted explicitly, so a
// self-hosted database that has revoked it from PUBLIC still works.
//
// Run as the owner of the tables (the role DATABASE_URL names for db:push,
// db:provision and auth:migrate). The login itself is made by hand with SQL
// (README, "Server database login"): this never creates it and never touches a
// password, and refuses when the login does not exist or holds more than a
// login should.
//
// Idempotent, and exact: every grant to the login on these tables, on public
// and in the owner's default privileges is revoked and the row grants applied
// again, in one transaction, so a re-run converges on the same rights whatever
// the login held before. Each statement is printed as it runs.
//
// Usage:
//   tsx src/db/grant-server-login.ts <login>          apply
//   tsx src/db/grant-server-login.ts <login> --dry    print the statements, change nothing

import { pool } from "./index.js";

const ROW_RIGHTS = "SELECT, INSERT, UPDATE, DELETE";

class Refusal extends Error {}

export function grantStatements(login: string, owner: string): string[] {
  const l = `"${login}"`;
  const o = `"${owner}"`;
  return [
    `REVOKE ALL ON SCHEMA public FROM ${l}`,
    `GRANT USAGE ON SCHEMA public TO ${l}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${l}`,
    `GRANT ${ROW_RIGHTS} ON ALL TABLES IN SCHEMA public TO ${l}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA public REVOKE ALL ON TABLES FROM ${l}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA public GRANT ${ROW_RIGHTS} ON TABLES TO ${l}`,
  ];
}

// The checks before anything is granted. Returns the owner (the connected role)
// and how many relations the grants cover.
async function preflight(login: string): Promise<{ owner: string; tables: number }> {
  const { rows: who } = await pool.query<{ owner: string }>(`select current_user as owner`);
  const owner = who[0].owner;
  if (login === owner) throw new Refusal(`${login} is the role this is connected as; run it as the owner, for another login`);

  const { rows: roles } = await pool.query<{
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
  }>(
    `select rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin
       from pg_roles where rolname = $1`,
    [login],
  );
  if (roles.length === 0) throw new Refusal(`login ${login} does not exist; create it with SQL first (README, "Server database login")`);
  const r = roles[0];

  // Any one of these is refused: a server login creates no logins or
  // databases and has no rights beyond the row grants below.
  const refusedAttributes: Array<[boolean, string]> = [
    [r.rolsuper, "SUPERUSER"],
    [r.rolcreaterole, "CREATEROLE"],
    [r.rolcreatedb, "CREATEDB"],
    [r.rolreplication, "REPLICATION"],
    [r.rolbypassrls, "BYPASSRLS"],
  ];
  const held = refusedAttributes.filter(([has]) => has).map(([, name]) => name);
  if (held.length) throw new Refusal(`${login} has ${held.join(", ")}; a server login has none of these`);
  if (!r.rolcanlogin) throw new Refusal(`${login} cannot log in (NOLOGIN)`);

  const { rows: memberOf } = await pool.query<{ rolname: string }>(
    `select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid
       join pg_roles u on u.oid = m.member where u.rolname = $1 order by 1`,
    [login],
  );
  if (memberOf.length) {
    throw new Refusal(`${login} is a member of ${memberOf.map((m) => m.rolname).join(", ")}; it would hold that role's rights too`);
  }

  const { rows: owned } = await pool.query<{ relname: string; owner: string }>(
    `select c.relname, pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      order by 1`,
  );
  const ownedByLogin = owned.filter((t) => t.owner === login);
  if (ownedByLogin.length) {
    throw new Refusal(`${login} owns ${ownedByLogin.map((t) => t.relname).join(", ")} in public; an owner keeps every right on its tables`);
  }
  const notOwner = owned.filter((t) => t.owner !== owner);
  if (notOwner.length) {
    throw new Refusal(
      `not every relation in public is owned by ${owner}: ${notOwner.map((t) => `${t.relname} (${t.owner})`).join(", ")}`,
    );
  }
  return { owner, tables: owned.length };
}

export async function grantServerLogin(login: string, dry = false): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(login)) {
    throw new Refusal(`login name must be lower-case letters, digits and _ (got ${JSON.stringify(login)})`);
  }
  const { owner, tables } = await preflight(login);
  process.stdout.write(`grant-server-login: owner ${owner}, login ${login}, ${tables} relation(s) in public\n`);
  const statements = grantStatements(login, owner);
  if (dry) {
    for (const s of statements) process.stdout.write(`grant-server-login: would run: ${s}\n`);
    return;
  }
  const client = await pool.connect();
  try {
    process.stdout.write("grant-server-login: BEGIN\n");
    await client.query("BEGIN");
    for (const s of statements) {
      process.stdout.write(`grant-server-login: ${s}\n`);
      await client.query(s);
    }
    await client.query("COMMIT");
    process.stdout.write("grant-server-login: COMMIT\n");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const names = args.filter((a) => a !== "--dry");
  if (names.length !== 1) throw new Refusal("usage: tsx src/db/grant-server-login.ts <login> [--dry]");
  await grantServerLogin(names[0], dry);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
    .catch((err) => {
      const msg = err instanceof Refusal ? `refused: ${err.message}` : err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`grant-server-login: ${msg}\n`);
      process.exitCode = err instanceof Refusal ? 2 : 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
