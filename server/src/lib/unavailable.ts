// "A dependency is down": the database, or the network path to it, cannot be
// reached right now. That is the caller's cue to retry (503 + Retry-After), not
// a bug in the request (4xx) or in us (500). Everything else stays a 500.
//
// The error is checked through its `cause` chain, because Drizzle wraps what pg
// throws (DrizzleQueryError.cause), Better Auth wraps what Drizzle throws, and
// Node's connect failure to a host with several addresses is an AggregateError
// whose `.errors` hold the per-address ECONNREFUSEDs.

import type { Response } from "express";

// Node socket / DNS errors: the connection could not be made or was cut.
const SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

// Postgres SQLSTATEs that mean the server is not accepting or has dropped us:
// class 08 (connection exception, matched by prefix below), 57P01 admin_shutdown,
// 57P02 crash_shutdown, 57P03 cannot_connect_now (starting up / recovering),
// 53300 too_many_connections.
const SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300"]);

// pg's own connection errors have no code, only a message (pg/lib/client.js,
// pg/lib/connection.js, pg-pool/index.js).
const PG_MESSAGES = [
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
  "Connection ended unexpectedly",
];

const MAX_DEPTH = 8;

function one(e: { code?: unknown; message?: unknown }): boolean {
  const code = e.code;
  if (typeof code === "string" && (SOCKET_CODES.has(code) || SQLSTATES.has(code) || code.startsWith("08"))) return true;
  const message = e.message;
  return typeof message === "string" && PG_MESSAGES.some((m) => message.includes(m));
}

export function isDependencyDown(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > MAX_DEPTH) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (one(e)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isDependencyDown(x, depth + 1))) return true;
  return isDependencyDown(e.cause, depth + 1);
}

// Long enough for Neon to wake (measured 1.5–2.3 s), short enough for a client
// that is waiting on it.
export const RETRY_AFTER_SECONDS = 5;

export function sendUnavailable(res: Response): void {
  res.status(503).set("Retry-After", String(RETRY_AFTER_SECONDS)).json({ error: "service_unavailable" });
}
