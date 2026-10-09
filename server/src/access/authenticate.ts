// Authentication for everything that serves recording content.
//
// A request is let in only if it carries a valid access token (auth/tokens.ts)
// AND its subject is an active member of the account, looked up in
// account_members on this request. The membership lookup is the revocation
// mechanism: a token that is still within its lifetime stops working the
// moment the member is removed, because the next request finds no active row.
// Nothing about the member is cached between requests.
//
// Two kinds of token are accepted, and each route accepts one (SAA-244):
//   mcp      audience …/mcp  — claude.ai, Claude Code. requireMember.
//   capture  audience …/capture, scope clipwise:capture — the recorder.
//            requireCapture.
// The route table (access/classification.ts, `requires`) says which a route
// takes, and check-access compares that with what these guards do.
//
// Every refusal is the same 401 — no token, a bad token, a token for another
// resource, a removed member — so the response does not say which. The one
// exception is a capture route given a valid MCP token: that is a 403
// insufficient_scope, naming the scope it needs.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { authConfigFromEnv } from "../auth/auth.js";
import { findMemberByAuthUserId } from "../auth/membership.js";
import { CAPTURE_SCOPE, type ExpectedResource } from "../auth/scopes.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import type { AccessContext } from "./context.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      access?: AccessContext;
    }
  }
}

export async function authenticate(req: Request, expected: ExpectedResource = "mcp"): Promise<AccessContext | null> {
  const header = req.headers.authorization;
  if (!header || !/^Bearer /i.test(header)) return null;
  const token = await verifyAccessToken(header.replace(/^Bearer /i, "").trim(), expected);
  if (!token) return null;
  const member = await findMemberByAuthUserId(token.sub);
  if (!member || member.removedAt) return null;
  return {
    accountId: member.accountId,
    memberId: member.id,
    role: member.role === "admin" ? "admin" : "member",
    authUserId: token.sub,
    email: member.email,
    scope: token.scope,
  };
}

export function unauthorized(res: Response): void {
  const resourceMetadata = `${authConfigFromEnv().baseURL}/.well-known/oauth-protected-resource`;
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadata}"`)
    .json({ error: "unauthorized" });
}

// A valid MCP token on a route that needs the capture scope: the caller is who
// they say, they just are not allowed to do this with this token.
function insufficientScope(res: Response): void {
  res
    .status(403)
    .set("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${CAPTURE_SCOPE}"`)
    .json({ error: "insufficient_scope", scope: CAPTURE_SCOPE });
}

function requireToken(expected: ExpectedResource): RequestHandler {
  // Fails closed: a server with no sign-in configured refuses content rather
  // than serving it to anyone.
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (!process.env.BETTER_AUTH_SECRET) {
      res.status(503).json({ error: "auth_not_configured" });
      return;
    }
    const ctx = await authenticate(req, expected);
    if (!ctx) {
      if (expected === "capture" && (await authenticate(req, "mcp"))) {
        insufficientScope(res);
        return;
      }
      unauthorized(res);
      return;
    }
    req.access = ctx;
    next();
  });
}

// The default guard: an MCP token (claude.ai, Claude Code).
export const requireMember: RequestHandler = requireToken("mcp");

// The recorder's guard: a capture token, with the capture scope.
export const requireCapture: RequestHandler = requireToken("capture");

// For routers whose reads take an MCP token and whose writes take a capture
// token — every router that has a write route today. Fails closed: only the
// safe methods (GET, HEAD, OPTIONS) take an MCP token; every other method
// takes a capture token, so a method nobody thought about is not open to MCP
// tokens. The table (classification.ts) is what says so; check-access compares
// it with this.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const requireMemberOrCaptureWrites: RequestHandler = (req, res, next) =>
  (SAFE_METHODS.has(req.method) ? requireMember : requireCapture)(req, res, next);

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.access?.role !== "admin") throw new HttpError(403, "admin_only");
  next();
};

// What a handler calls to get the caller. Throws rather than returning
// undefined, so a route mounted without requireMember fails loudly.
export function accessOf(req: Request): AccessContext {
  if (!req.access) throw new HttpError(401, "unauthorized");
  return req.access;
}

// The URL still carries :accountId on the older routes. It is no longer where
// the account comes from — only a check that the caller asked for their own.
export const sameAccountOnly: RequestHandler = (req, _res, next) => {
  const ctx = accessOf(req);
  if (req.params.accountId !== undefined && req.params.accountId !== ctx.accountId) {
    throw new HttpError(404, "account_not_found");
  }
  next();
};
