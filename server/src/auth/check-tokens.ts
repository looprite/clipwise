// Regression check for verifyAccessToken: which tokens are let in. Tokens are
// signed here with a throwaway key and verified against a config this file
// chooses, so there is no database and no server. Same plain-script/exit-code
// shape as check-assign-voice.ts.
//
// Usage:
//   tsx src/auth/check-tokens.ts

import { SignJWT, createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { CAPTURE_SCOPE, type ExpectedResource } from "./scopes.js";
import { verifyAccessToken } from "./tokens.js";

const config = {
  baseURL: "https://clip.example.test",
  mcpResource: "https://clip.example.test/mcp",
  captureResource: "https://clip.example.test/capture",
};
const ISSUER = `${config.baseURL}/api/auth`;
const USERINFO = `${ISSUER}/oauth2/userinfo`;

const mine = await generateKeyPair("EdDSA", { extractable: true });
const other = await generateKeyPair("EdDSA", { extractable: true });
const jwk = { ...(await exportJWK(mine.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" };
const keys = createLocalJWKSet({ keys: [jwk] });

async function sign(
  over: { payload?: JWTPayload; typ?: string; key?: typeof mine.privateKey; expiresIn?: string | number; issuer?: string; drop?: string[] } = {},
): Promise<string> {
  const payload: JWTPayload = {
    sub: "user-1",
    aud: [config.mcpResource, USERINFO],
    scope: "openid offline_access",
    client_id: "client-1",
    ...over.payload,
  };
  for (const k of over.drop ?? []) delete payload[k];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", typ: over.typ ?? "at+jwt", kid: "k1" })
    .setIssuer(over.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(over.expiresIn ?? "10m")
    .sign(over.key ?? mine.privateKey);
}

// `as` is the resource the verifier is told to expect (default: mcp).
type Case = { name: string; token: () => Promise<string>; expect: "ok" | "refused"; as?: ExpectedResource };
const CAPTURE_PAYLOAD = { aud: [config.captureResource, USERINFO], scope: `openid offline_access ${CAPTURE_SCOPE}` };
const CASES: Case[] = [
  { name: "a token for this resource, as Better Auth issues it (resource + userinfo audiences), is accepted", token: () => sign(), expect: "ok" },
  { name: "a token whose only audience is this resource is accepted", token: () => sign({ payload: { aud: config.mcpResource } }), expect: "ok" },
  { name: "a token for a different resource is refused", token: () => sign({ payload: { aud: "https://other.example.test/mcp" } }), expect: "refused" },
  {
    name: "a token for this resource AND another is refused (audience confusion)",
    token: () => sign({ payload: { aud: [config.mcpResource, "https://other.example.test/mcp"] } }),
    expect: "refused",
  },
  { name: "a token for another resource that merely carries the userinfo audience is refused", token: () => sign({ payload: { aud: [USERINFO] } }), expect: "refused" },
  { name: "a token from another issuer is refused", token: () => sign({ issuer: "https://elsewhere.example.test/api/auth" }), expect: "refused" },
  { name: "an expired token is refused", token: () => sign({ expiresIn: Math.floor(Date.now() / 1000) - 3600 }), expect: "refused" },
  { name: "a token signed with a key that is not in the published set is refused", token: () => sign({ key: other.privateKey }), expect: "refused" },
  { name: "an ID token (typ JWT) is not an access token and is refused", token: () => sign({ typ: "JWT" }), expect: "refused" },
  { name: "a token with no subject is refused", token: () => sign({ drop: ["sub"] }), expect: "refused" },
  { name: "garbage is refused", token: async () => "not.a.token", expect: "refused" },
  { name: "an empty string is refused", token: async () => "", expect: "refused" },
  // SAA-244: the two kinds of token, and neither is accepted in the other's place.
  { name: "capture: a token for the capture resource with the capture scope is accepted as a capture token", token: () => sign({ payload: CAPTURE_PAYLOAD }), expect: "ok", as: "capture" },
  { name: "capture: that same token is refused where an MCP token is expected", token: () => sign({ payload: CAPTURE_PAYLOAD }), expect: "refused", as: "mcp" },
  { name: "capture: an MCP token is refused where a capture token is expected", token: () => sign(), expect: "refused", as: "capture" },
  {
    name: "capture: a token for the capture resource WITHOUT the capture scope is refused as a capture token",
    token: () => sign({ payload: { ...CAPTURE_PAYLOAD, scope: "openid offline_access" } }),
    expect: "refused",
    as: "capture",
  },
  {
    name: "capture: a token naming both resources is refused either way (audience confusion)",
    token: () => sign({ payload: { aud: [config.mcpResource, config.captureResource, USERINFO], scope: `openid ${CAPTURE_SCOPE}` } }),
    expect: "refused",
    as: "capture",
  },
  {
    name: "capture: ...and as an MCP token",
    token: () => sign({ payload: { aud: [config.mcpResource, config.captureResource, USERINFO], scope: `openid ${CAPTURE_SCOPE}` } }),
    expect: "refused",
    as: "mcp",
  },
];

let failed = 0;
for (const c of CASES) {
  const got = await verifyAccessToken(await c.token(), c.as ?? "mcp", { keys, config });
  const actual = got ? "ok" : "refused";
  const ok = actual === c.expect;
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : ` — expected ${c.expect}, got ${actual}`}\n`);
}

const good = await verifyAccessToken(await sign(), "mcp", { keys, config });
const shape = good?.sub === "user-1" && good.scope.join() === "openid,offline_access" && good.clientId === "client-1";
if (!shape) failed++;
process.stdout.write(`${shape ? "ok  " : "FAIL"} an accepted token yields its subject, scopes and client\n`);

// What null means: only jose can say "this token is not valid". Any other error
// (a key set that could not be fetched, a bug) rejects, so the caller can tell an
// outage from a bad token (access/authenticate.ts answers 503 for the first).
let extra = 0;
function check(ok: boolean, name: string): void {
  extra++;
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}\n`);
}
const boom = new Error("keys unavailable (not a JOSE error)");
const throwing = (err: Error): JWTVerifyGetKey => async () => {
  throw err;
};
const rejected = await verifyAccessToken(await sign(), "mcp", { keys: throwing(boom), config }).then(
  () => null,
  (e: unknown) => e,
);
check(rejected === boom, "a non-JOSE error from the key lookup rejects (it is not turned into null)");
const joseNull = await verifyAccessToken(await sign(), "mcp", { keys: throwing(new errors.JWKSNoMatchingKey()), config }).then(
  (v) => v,
  () => "rejected",
);
check(joseNull === null, "a JOSE error from the key lookup returns null");
let keyCalls = 0;
const counting: JWTVerifyGetKey = async (...a) => {
  keyCalls++;
  return keys(...a);
};
const shapes = ["not.a.token", "", "a.b.c", "Bearer x", "....", "eyJhbGciOiJFZERTQSJ9"];
const results = await Promise.all(shapes.map((t) => verifyAccessToken(t, "mcp", { keys: counting, config }).then((v) => v, () => "rejected")));
check(results.every((r) => r === null), "strings that are not shaped like a token return null");
check(keyCalls === 0, "...and the key lookup is never called for them");

process.stdout.write(`\n${CASES.length + 1 + extra - failed}/${CASES.length + 1 + extra} passed\n`);
process.exit(failed === 0 ? 0 : 1);
