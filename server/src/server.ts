import "dotenv/config";
import { createServer, type Server } from "node:http";
import { createGate } from "./boot.js";
import { pool } from "./db/index.js";
import { logError } from "./lib/safe-error.js";
// A type only: erased at build, so the worker's modules are not loaded here.
import type { JobWorker } from "./jobs/worker.js";

// Starts the server and returns the function that shuts it down (index.ts calls
// it on SIGTERM/SIGINT).
//
// Shutdown: stop accepting connections, let requests already in flight finish,
// stop the jobs worker (it aborts the job in flight and gives it back to the
// queue without using an attempt), close the database pool, exit 0. The pool is
// closed last because the worker's requeue goes through it. The cap must stay
// below kill_timeout in fly.toml, which is when the host sends SIGKILL; past the
// cap we exit 1 rather than hang.
const DRAIN_CAP_MS = 10_000;

function exitAfterPoolClose(): void {
  pool
    .end()
    .then(() => {
      console.log("shutdown: database pool closed, exiting 0");
      process.exit(0);
    })
    .catch((err: unknown) => {
      logError("shutdown: closing the pool failed", err);
      process.exit(1);
    });
}

export async function startServer(): Promise<(signal: string) => void> {
  let stopping = false;
  // Set once the worker has started; until then a shutdown has no worker to stop,
  // and the load below sees `stopping` and does not start one.
  let worker: JobWorker | null = null;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    if (worker) {
      console.log(`shutdown: ${signal} received, no longer accepting connections; waiting for in-flight requests and stopping the jobs worker (cap ${DRAIN_CAP_MS / 1000}s)`);
    } else {
      console.log(`shutdown: ${signal} received while starting (the app is still loading), no longer accepting connections; the jobs worker will not start (cap ${DRAIN_CAP_MS / 1000}s)`);
    }
    const cap = setTimeout(() => {
      console.error(`shutdown: requests or the jobs worker still running after ${DRAIN_CAP_MS / 1000}s, exiting 1`);
      process.exit(1);
    }, DRAIN_CAP_MS);
    cap.unref();
    const drained = new Promise<void>((resolve) => {
      server.close(() => {
        console.log("shutdown: requests drained");
        resolve();
      });
    });
    // stop() does not reject: the worker logs its own errors.
    const stopped = worker
      ? worker.stop().then(() => console.log("shutdown: jobs worker stopped"))
      : Promise.resolve();
    void Promise.all([drained, stopped]).then(exitAfterPoolClose);
    // Keep-alive connections with no request on them would hold server.close() open.
    server.closeIdleConnections();
  };

  // Listen first (boot.ts): the port is open before the app loads, so a health
  // check connects at once instead of being refused for the whole load, and
  // anything that gets in before the app is ready is answered by the gate.
  // app.js is imported here and not at the top, because importing it is most of
  // the load, and from the listen callback and not right after listen(): the
  // import evaluates the whole module graph in one synchronous stretch, and
  // started before the callback it would run first and "listening" would wait
  // for it. A request that arrives during that stretch waits for it (about 220 ms
  // on a laptop); it is not refused.
  const gate = createGate();
  const port = Number(process.env.PORT ?? 3000);
  const server: Server = createServer(gate.listener);
  server.listen(port, () => {
    console.log(`Clipwise server listening on port ${port}`);
    import("./app.js")
      .then(({ buildApp }) => buildApp())
      .then(async ({ app }) => {
        gate.ready(app);
        console.log("Clipwise app ready");
        // The worker pulls in extraction, the Anthropic SDK and the database, so it
        // is imported here, after the app is ready, and not at the top of this file
        // where it would be loaded before listen(). Once, not awaited: start()
        // picks up whatever a previous process left unfinished. Not at all if a
        // shutdown began while any of this was loading.
        if (stopping) return;
        const [{ JobWorker }, { registerWorker }] = await Promise.all([import("./jobs/worker.js"), import("./jobs/registry.js")]);
        if (stopping) return;
        worker = new JobWorker();
        registerWorker(worker);
        void worker.start();
      })
      .catch((err: unknown) => {
        logError("startup: building the app failed", err);
        process.exit(1);
      });
  });
  return shutdown;
}
