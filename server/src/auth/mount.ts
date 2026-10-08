// Mounts Better Auth's handler on an Express app at /api/auth/*.
//
// Must be called before express.json(): Better Auth reads the raw request
// stream itself, and a body parser that runs first consumes it (Better Auth's
// Express integration notes). Express 4 wildcard syntax.
//
// Client address, for rate limiting. Better Auth reads it from
// x-forwarded-for unless told otherwise. A request with no address it can find
// falls into one shared bucket per path (1.7.7 warns about it), so a
// misconfigured proxy lets one client use up everyone's sign-in allowance; and
// any client can pick its own bucket by sending that header itself. This only
// ever hands Better Auth an address we trust:
//   - AUTH_IP_HEADER set (behind a proxy that sets that header, e.g.
//     fly-client-ip): the request must carry it, or it is refused;
//   - unset (direct connection): the socket's own address replaces whatever
//     x-forwarded-for the client sent.
// Behind a proxy with AUTH_IP_HEADER unset every request shares the proxy's
// address, i.e. one bucket for everyone — set it.

import type { Express, Request, Response, NextFunction } from "express";
import { toNodeHandler } from "better-auth/node";
import { authConfigFromEnv, getAuth, type Auth } from "./auth.js";

// An explicit `auth` (the check scripts pass one) is used as is. Without one,
// each request asks getAuth() for the current instance, so a Better Auth that
// failed to start (database unreachable) is replaced on a later request rather
// than staying dead until a restart; starting one here warms it up for boot.
export function mountAuth(
  app: Express,
  auth?: Auth,
  ipAddressHeader: string | null = authConfigFromEnv().ipAddressHeader,
): void {
  if (!auth) getAuth();
  const handlers = new WeakMap<Auth, ReturnType<typeof toNodeHandler>>();
  const handlerFor = (a: Auth) => {
    let h = handlers.get(a);
    if (!h) handlers.set(a, (h = toNodeHandler(a)));
    return h;
  };
  app.use("/api/auth", (req: Request, res: Response, next: NextFunction) => {
    if (ipAddressHeader) {
      const value = req.headers[ipAddressHeader];
      if (typeof value !== "string" || value.trim() === "") {
        res.status(400).json({ error: "client_address_unavailable" });
        return;
      }
    } else {
      req.headers["x-forwarded-for"] = req.socket.remoteAddress ?? "unknown";
    }
    next();
  });
  // toNodeHandler has no catch and Express 4 does not catch a rejected async
  // handler, so an auth failure here would otherwise take the process down.
  app.all("/api/auth/*", async (req: Request, res: Response) => {
    try {
      await handlerFor(auth ?? getAuth())(req, res);
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      console.error(`auth: request failed: ${e?.name ?? "Error"} ${e?.code ?? ""} ${e?.message ?? ""}`.trim());
      if (!res.headersSent) res.status(503).json({ error: "auth_unavailable" });
    }
  });
}
