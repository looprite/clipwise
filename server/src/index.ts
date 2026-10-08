// Entry point. Deliberately imports nothing heavy: static imports run before any
// code in this file, and loading the server's modules takes most of a second.
// As PID 1 in a container Node ignores SIGTERM until a handler exists, so a stop
// that arrived during that second would wait out the host's whole kill_timeout
// and be killed. The handlers go in first; the server is loaded after.
let shutdown: ((signal: string) => void) | undefined;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shutdown) {
      shutdown(signal);
    } else {
      // Still loading: nothing is listening and no request can be in flight.
      console.log(`shutdown: ${signal} received while starting, exiting 0`);
      process.exit(0);
    }
  });
}

const { startServer } = await import("./server.js");
shutdown = await startServer();
