// The two discovery documents a client reads before it can sign anyone in.
//
//  1. Protected-resource metadata (RFC 9728): tells Claude which authorization
//     server vouches for /mcp. Better Auth does not serve one, so it is built
//     here. `resource` must equal the MCP URL exactly as the user typed it, and
//     Claude uses only the first entry of `authorization_servers`
//     (claude.com/docs/connectors/building/authentication).
//  2. Authorization-server metadata (RFC 8414): Better Auth serves it under its
//     own path (/api/auth/.well-known/…). The issuer has a path component, so a
//     client following RFC 8414 looks at the origin root with the path inserted
//     (/.well-known/oauth-authorization-server/api/auth); the alias below
//     answers that from Better Auth's own document. Clients that follow OpenID
//     discovery find /api/auth/.well-known/openid-configuration directly.
//
// Both are public by design and carry no data about any account.

import type { RequestHandler } from "express";
import { asyncHandler, HttpError } from "../lib/http.js";
import { authConfigFromEnv, getAuth, type AuthConfig } from "./auth.js";

function config(): AuthConfig {
  try {
    return authConfigFromEnv();
  } catch {
    throw new HttpError(503, "auth_not_configured");
  }
}

export const protectedResourceMetadata: RequestHandler = (_req, res) => {
  const cfg = config();
  res.set("Cache-Control", "public, max-age=300").json({
    resource: cfg.mcpResource,
    authorization_servers: [`${cfg.baseURL}/api/auth`],
    bearer_methods_supported: ["header"],
    resource_name: "Clipwise",
  });
};

export const authorizationServerMetadata: RequestHandler = asyncHandler(async (_req, res) => {
  config();
  res.set("Cache-Control", "public, max-age=300").json(await getAuth().api.getOAuthServerConfig());
});
