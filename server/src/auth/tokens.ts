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
// include this instance's MCP resource, and may include nothing else except
// the issuer's own userinfo endpoint (which Better Auth adds whenever the
// openid scope is granted). A token that names any other audience was issued
// for a different resource and is refused (GHSA-p2fr: audience confusion).
//
// A valid token is necessary, not sufficient: access/authenticate.ts then
// requires an active member row on every request, so removing a member ends
// their access on the next call without waiting for the token to expire.

import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";
import { authConfigFromEnv, getAuth } from "./auth.js";

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
  inject: { keys?: JWTVerifyGetKey; config?: { baseURL: string; mcpResource: string } } = {},
): Promise<VerifiedToken | null> {
  const cfg = inject.config ?? authConfigFromEnv();
  const issuer = `${cfg.baseURL}/api/auth`;
  const options: JWTVerifyOptions = { issuer, typ: "at+jwt", algorithms: ["EdDSA"], clockTolerance: 5 };
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
    if (!audiences.includes(cfg.mcpResource)) return null;
    if (audiences.some((a) => a !== cfg.mcpResource && a !== allowedExtra)) return null;
    if (typeof payload.sub !== "string" || payload.sub === "") return null;
    return {
      sub: payload.sub,
      scope: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
      clientId: typeof payload.client_id === "string" ? payload.client_id : null,
    };
  } catch {
    return null;
  }
}
