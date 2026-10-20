// Regression check for the http:// origin guard in authConfigFromEnv (SAA-243):
// an http:// BETTER_AUTH_URL is refused when the database is not on this
// machine, unless AUTH_ALLOW_HTTP_ORIGIN=true. Each case calls the config
// builder with an environment it chooses, so there is no database and no
// server. Same plain-script/exit-code shape as check-tokens.ts.
//
// Usage:
//   tsx src/auth/check-auth-origin.ts

// auth.ts imports the pool (db/index.ts), which needs a DATABASE_URL to load.
// It never connects here: nothing queries it.
process.env.DATABASE_URL ??= "postgres://check@127.0.0.1:1/none";
const { authConfigFromEnv } = await import("./auth.js");

const SECRET = "check-secret-check-secret-check-secret";
const NEON = "postgresql://check_user:check-password-not-real@ep-check-123.c-2.us-west-2.aws.neon.tech/neondb?sslmode=verify-full";

type Case = { name: string; env: Record<string, string>; expect: "allowed" | "refused" };
const cases: Case[] = [
  { name: "http:// origin, Neon database: refused", env: { BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: NEON }, expect: "refused" },
  { name: "HTTP:// in capitals, Neon database: refused", env: { BETTER_AUTH_URL: "HTTP://localhost:3000", DATABASE_URL: NEON }, expect: "refused" },
  { name: "http:// origin, no DATABASE_URL: refused", env: { BETTER_AUTH_URL: "http://localhost:3000" }, expect: "refused" },
  {
    name: "http:// origin, Neon database, opt-in set to something other than \"true\": refused",
    env: { BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: NEON, AUTH_ALLOW_HTTP_ORIGIN: "1" },
    expect: "refused",
  },
  { name: "http:// origin, database on localhost: allowed", env: { BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: "postgres://u:p@localhost:5432/db" }, expect: "allowed" },
  { name: "http:// origin, database on 127.0.0.1: allowed", env: { BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db" }, expect: "allowed" },
  { name: "http:// origin, database on ::1: allowed", env: { BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: "postgres://u:p@[::1]:5432/db" }, expect: "allowed" },
  {
    name: "http:// origin, Neon database, AUTH_ALLOW_HTTP_ORIGIN=true: allowed",
    env: { BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: NEON, AUTH_ALLOW_HTTP_ORIGIN: "true" },
    expect: "allowed",
  },
  { name: "https:// origin, Neon database: allowed", env: { BETTER_AUTH_URL: "https://looprite.clipwiseapp.com", DATABASE_URL: NEON }, expect: "allowed" },
];

let failed = 0;
for (const c of cases) {
  let got: "allowed" | "refused";
  let message = "";
  try {
    authConfigFromEnv({ BETTER_AUTH_SECRET: SECRET, ...c.env });
    got = "allowed";
  } catch (err) {
    got = "refused";
    message = err instanceof Error ? err.message : String(err);
  }
  let ok = got === c.expect;
  let detail: string = got;
  if (got === "refused" && c.expect === "refused") {
    // The refusal names the origin and the database host, and never the user
    // or password from the connection string.
    const host = c.env.DATABASE_URL ? new URL(c.env.DATABASE_URL).hostname : "(none)";
    const names = message.includes("http://localhost:3000") && message.includes(host);
    const leaks = message.includes("check_user") || message.includes("check-password-not-real");
    ok = names && !leaks;
    detail = `refused; names origin and host: ${names}; leaks credentials: ${leaks}`;
  }
  if (!ok) failed++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${c.name}  (${detail})\n`);
}
process.stdout.write(failed ? `\n${failed} of ${cases.length} failed\n` : `\nall ${cases.length} passed\n`);
process.exitCode = failed ? 1 : 0;
