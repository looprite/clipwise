// Verifies an access token issued by this instance's Better Auth, for the
// resource server side (REST and, later, /mcp). Better Auth is the
// authorization server; this is the other half and is deliberately ours, so it
// does not depend on the auth library's MCP route helper or its SDK pin.
//
// What a token is, as observed from a real flow (2026-10-08): a JWT with
// typ "at+jwt", signed EdDSA with a key published in the jwks table;
// iss = <baseURL>/api/auth; sub = the Better Auth user id; aud = [the MCP
// resource, <iss>/oauth2/userinfo]; exp - iat = AUTH_ACCESS_TOKEN_SECONDS.
//
// Checked here: signature, issuer, expiry, and audience. The audience must
// include the resource the caller says it is protecting ("mcp": this instance's
// MCP resource; "capture": its capture resource, SAA-244), and may include
// nothing else except the issuer's own userinfo endpoint (which Better Auth
// adds whenever the openid scope is granted). A token that names any other
// audience was issued for a different resource and is refused (GHSA-p2fr:
// audience confusion) — so a capture token is refused where an MCP token is
// expected, and the other way round. A capture token must also carry the
// capture scope.
//
// A valid token is necessary, not sufficient: access/authenticate.ts then
// requires an active member row on every request, so removing a member ends
// their access on the next call without waiting for the token to expire.

import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";
import { authConfigFromEnv, getAuth } from "./auth.js";
import { CAPTURE_SCOPE, type ExpectedResource } from "./scopes.js";

export type VerifiedToken = { sub: string; scope: string[]; clientId: string | null };

let cached: { keys: ReturnType<typeof createLocalJWKSet>; at: number } | null = null;
const JWKS_TTL_MS = 5 * 60 * 1000;

async function keyset(force: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
  if (!force && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const jwks = (await getAuth().api.getJwks()) as unknown as JSONWebKeySet;
  cached = { keys: createLocalJWKSet(jwks), at: Date.now() };
  return cached.keys;
}

// `inject` is for check-tokens.ts, which tests the rules with a key it made
// itself and a config it chose, so no database or running server is needed.
export async function verifyAccessToken(
  token: string,
  expected: ExpectedResource,
  inject: { keys?: JWTVerifyGetKey; config?: { baseURL: string; mcpResource: string; captureResource: string } } = {},
): Promise<VerifiedToken | null> {
  const cfg = inject.config ?? authConfigFromEnv();
  const issuer = `${cfg.baseURL}/api/auth`;
  const options: JWTVerifyOptions = { issuer, typ: "at+jwt", algorithms: ["EdDSA"], clockTolerance: 5 };
  // A string that is not shaped like a token is refused here, before any key is
  // fetched: garbage gets 401 even when the database is down.
  // decodeProtectedHeader only parses the string (no I/O), and for a string that
  // is not a JWT it throws a plain TypeError, not a JOSEError (jose 6.2.12,
  // lib/validate.js), so here any throw means "not a token".
  try {
    decodeProtectedHeader(token);
  } catch {
    return null;
  }
  try {
    let result;
    if (inject.keys) {
      result = await jwtVerify(token, inject.keys, options);
    } else {
      try {
        result = await jwtVerify(token, await keyset(false), options);
      } catch (err) {
        // A key we have not seen yet (rotation): refresh once and retry.
        if (!(err instanceof errors.JWKSNoMatchingKey)) throw err;
        result = await jwtVerify(token, await keyset(true), options);
      }
    }
    const { payload } = result;
    const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    const allowedExtra = `${issuer}/oauth2/userinfo`;
    const resource = expected === "capture" ? cfg.captureResource : cfg.mcpResource;
    if (!audiences.includes(resource)) return null;
    if (audiences.some((a) => a !== resource && a !== allowedExtra)) return null;
    if (typeof payload.sub !== "string" || payload.sub === "") return null;
    const scope = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    if (expected === "capture" && !scope.includes(CAPTURE_SCOPE)) return null;
    return {
      sub: payload.sub,
      scope,
      clientId: typeof payload.client_id === "string" ? payload.client_id : null,
    };
  } catch (err) {
    // null means "this token is not valid", and only jose can say so. Anything
    // else (the database behind the key set, a bug) is not the token's fault and
    // is thrown, so an outage is a 503 and not a 401 that sends the recorder
    // back to sign in.
    if (err instanceof errors.JOSEError) return null;
    throw err;
  }
}
