// The Express app, built in one place so the access check can build the real
// thing and list every route on it (access/route-list.ts).
//
// Who may reach what is decided here, by mount:
//   - /health, /api/auth/* (Better Auth's own gating) and the Google Calendar
//     callback (gated by a single-use state) are reachable without a token;
//   - everything else goes through requireMember: a valid access token AND an
//     active member row on this request (access/authenticate.ts);
//   - the older routes keep :accountId in the URL, which sameAccountOnly checks
//     against the caller's own account — it no longer decides which account;
//   - starting a Google Calendar connection also needs an admin.
// A router mounted any other way, or a route added outside the mounts, is not
// in the classification table and check-access.ts fails on it.

import express, { type Express, type RequestHandler, type Router } from "express";
import { sql } from "drizzle-orm";
import { requireAdmin, requireMember, sameAccountOnly } from "./access/authenticate.js";
import { authorizationServerMetadata, protectedResourceMetadata } from "./auth/discovery.js";
import { consentPage, loginPage } from "./auth/pages.js";
import { db } from "./db/index.js";
import { errorHandler } from "./lib/http.js";
import { logError } from "./lib/safe-error.js";
import { mcpMethodNotAllowed, mcpPost } from "./mcp/server.js";
import { accountsRouter } from "./routes/accounts.js";
import { momentsRouter } from "./routes/moments.js";
import { oauthRouter } from "./routes/oauth.js";
import { peopleRouter } from "./routes/people.js";
import { recordingsRouter } from "./routes/recordings.js";
import { transcriptRouter } from "./routes/transcript.js";

export type Mount = { prefix: string; router: Router };

export async function buildApp(): Promise<{ app: Express; mounts: Mount[] }> {
  const app = express();
  const mounts: Mount[] = [];
  const mount = (prefix: string, guards: RequestHandler[], router: Router): void => {
    app.use(prefix, ...guards, router);
    mounts.push({ prefix, router });
  };

  // Sign-in (src/auth). Ahead of express.json(), which would consume the body
  // Better Auth reads itself (see auth/mount.ts). Mounted only when configured;
  // without it every route below answers 503 rather than serving anyone.
  if (process.env.BETTER_AUTH_SECRET) {
    const { mountAuth } = await import("./auth/mount.js");
    mountAuth(app);
  }

  app.use(express.json({ limit: "16mb" }));

  // Liveness: the process is up and serving. Never touches the database, so a
  // host or compose health check on it neither fails during a database outage
  // (a restart would not help) nor keeps Neon's compute awake. /health below is
  // readiness.
  app.get("/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/health", async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.status(200).json({ status: "ok", db: "ok" });
    } catch (err) {
      logError("health check: database unreachable", err);
      res.status(503).json({ status: "error", db: "unreachable" });
    }
  });

  // What a client reads and shows to sign someone in for Claude: the discovery
  // documents (/mcp's 401 points at the first) and the login and consent pages
  // Better Auth redirects to. Public by design; none carries account data.
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
  app.get("/.well-known/oauth-authorization-server/api/auth", authorizationServerMetadata);
  app.get("/login", loginPage);
  app.get("/consent", consentPage);

  // The MCP endpoint. Stateless Streamable HTTP, so POST only; GET and DELETE
  // are refused after authentication. A missing, bad or revoked login is a 401
  // that points at the metadata above, which is what starts Claude's sign-in.
  app.post("/mcp", requireMember, mcpPost);
  app.get("/mcp", requireMember, mcpMethodNotAllowed);
  app.delete("/mcp", requireMember, mcpMethodNotAllowed);

  // Guards for routes that live in routers mounted at "/" with fully
  // qualified paths.
  app.use("/recordings", requireMember);
  app.use("/oauth/google/connect", requireMember, requireAdmin);

  mount("/accounts/:accountId/people", [requireMember, sameAccountOnly], peopleRouter);
  mount("/accounts/:accountId/recordings", [requireMember, sameAccountOnly], recordingsRouter);
  mount("/accounts/:accountId/moments", [requireMember, sameAccountOnly], momentsRouter);
  mount("/accounts", [requireMember], accountsRouter);
  mount("/", [], transcriptRouter);
  mount("/", [], oauthRouter);

  app.use(errorHandler);
  return { app, mounts };
}
