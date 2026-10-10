// Outage check: what the real app answers when the database cannot be reached.
// DATABASE_URL must point at a closed port (the check makes one and sets it
// itself); nothing is written anywhere. Tokens are well-formed but signed with a
// throwaway key, so they are "valid" as far as shape goes and the key lookup is
// what fails.
//
//   a well-formed token         -> 503 + Retry-After   (was 401)
//   a string that is no token   -> 401                 (no key lookup needed)
//   the discovery route         -> 503                 (was 500)
//   /live                       -> 200
//   an error that is not an outage, thrown from the token check -> 500, and the
//   process answers the next request
//
// Usage: tsx src/access/check-outage.ts   (BETTER_AUTH_SECRET and BETTER_AUTH_URL set)

import { createServer, type AddressInfo } from "node:net";
import { SignJWT, generateKeyPair } from "jose";

const closed = await new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const port = (s.address() as AddressInfo).port;
    s.close(() => resolve(port));
  });
});
process.env.DATABASE_URL = `postgres://nobody:nothing@127.0.0.1:${closed}/none`;

const { buildApp } = await import("../app.js");
const { authConfigFromEnv } = await import("../auth/auth.js");
const cfg = authConfigFromEnv();
const { app } = await buildApp();
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const kp = await generateKeyPair("EdDSA", { extractable: true });
const token = await new SignJWT({ sub: "user-1", aud: [cfg.mcpResource], scope: "openid" })
  .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "k1" })
  .setIssuer(`${cfg.baseURL}/api/auth`)
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(kp.privateKey);

let failed = 0;
let total = 0;
async function expectStatus(name: string, path: string, headers: Record<string, string>, status: number, retryAfter: boolean): Promise<void> {
  total++;
  const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(20000) });
  const body = await res.text();
  const ra = res.headers.get("retry-after");
  const ok = res.status === status && (ra !== null) === retryAfter;
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}: ${res.status} retry-after=${ra} ${body.slice(0, 80)}${ok ? "" : ` — expected ${status}`}\n`);
}

await expectStatus("a well-formed token on /accounts", "/accounts", { authorization: `Bearer ${token}` }, 503, true);
await expectStatus("a string that is not a token on /accounts", "/accounts", { authorization: "Bearer not.a.token" }, 401, false);
await expectStatus("the discovery route", "/.well-known/oauth-authorization-server/api/auth", {}, 503, true);
await expectStatus("/live", "/live", {}, 200, false);

// A failure that is not an outage: the token check cannot read its own config.
// Plain Error from authConfigFromEnv, not a connection error.
const savedUrl = process.env.BETTER_AUTH_URL;
delete process.env.BETTER_AUTH_URL;
await expectStatus("a non-outage error thrown from the token check", "/accounts", { authorization: `Bearer ${token}` }, 500, false);
process.env.BETTER_AUTH_URL = savedUrl;
await expectStatus("the process still answers (/live after the 500)", "/live", {}, 200, false);

process.stdout.write(`\n${total - failed}/${total} passed\n`);
server.close();
process.exit(failed === 0 ? 0 : 1);
