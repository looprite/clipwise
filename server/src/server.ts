import "dotenv/config";
import type { Server } from "node:http";
import { buildApp } from "./app.js";
import { pool } from "./db/index.js";

// Starts the server and returns the function that shuts it down (index.ts calls
// it on SIGTERM/SIGINT).
//
// Shutdown: stop accepting connections, let requests already in flight finish,
// close the database pool, exit 0. The server holds no jobs (extraction runs on
// the Mac), so nothing is lost or repeated by stopping. The cap must stay below
// kill_timeout in fly.toml, which is when the host sends SIGKILL; past the cap
// we exit 1 rather than hang.
const DRAIN_CAP_MS = 10_000;

function exitAfterPoolClose(): void {
  pool
    .end()
    .then(() => {
      console.log("shutdown: database pool closed, exiting 0");
      process.exit(0);
    })
    .catch((err: unknown) => {
      const e = err as { name?: string; code?: string; message?: string };
      console.error(`shutdown: closing the pool failed: ${e?.name ?? "Error"} ${e?.code ?? ""} ${e?.message ?? ""}`.trim());
      process.exit(1);
    });
}

export async function startServer(): Promise<(signal: string) => void> {
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`shutdown: ${signal} received, no longer accepting connections; waiting for in-flight requests (cap ${DRAIN_CAP_MS / 1000}s)`);
    const cap = setTimeout(() => {
      console.error(`shutdown: requests still in flight after ${DRAIN_CAP_MS / 1000}s, exiting 1`);
      process.exit(1);
    }, DRAIN_CAP_MS);
    cap.unref();
    server.close(() => {
      console.log("shutdown: requests drained");
      exitAfterPoolClose();
    });
    // Keep-alive connections with no request on them would hold server.close() open.
    server.closeIdleConnections();
  };

  const { app } = await buildApp();
  const port = Number(process.env.PORT ?? 3000);
  const server: Server = app.listen(port, () => {
    console.log(`Clipwise server listening on port ${port}`);
  });
  return shutdown;
}
