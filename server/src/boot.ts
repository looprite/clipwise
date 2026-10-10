// What answers while the app is still loading (SAA-227 decision 8).
//
// The process listens first and builds the Express app afterwards; loading
// Better Auth and the routers took 4-5 s on Fly, and the host's health check
// failed once on every boot inside that window. Until the app is ready this
// answers /live 200 (the process is up) and everything else 503 with Retry-After,
// so nothing is served by half a server. Once ready, every request goes to the
// app. Imports nothing heavy, so it is loaded before the app is.

import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export const STARTING_RETRY_AFTER_SECONDS = 2;

export function createGate(): { listener: RequestListener; ready: (app: RequestListener) => void; isReady: () => boolean } {
  let app: RequestListener | null = null;
  const listener: RequestListener = (req, res) => {
    if (app) {
      app(req, res);
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    const head = req.method === "HEAD";
    if ((req.method === "GET" || head) && path === "/live") {
      const body = JSON.stringify({ status: "ok" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      res.end(head ? undefined : body);
      return;
    }
    const body = JSON.stringify({ error: "starting" });
    res.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Retry-After": String(STARTING_RETRY_AFTER_SECONDS),
      "Cache-Control": "no-store",
    });
    res.end(head ? undefined : body);
  };
  return { listener, ready: (a) => { app = a; }, isReady: () => app !== null };
}
