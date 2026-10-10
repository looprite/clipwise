// How the request side reaches the worker without importing it: the server
// registers the worker it started, and POST /captures calls wakeWorker() once a
// job is committed. With none registered (a check mounting the route alone, a
// CLI) waking does nothing; the job waits in the table for the next boot.

export type Wakeable = { wake(): void };

let current: Wakeable | null = null;

export function registerWorker(worker: Wakeable | null): void {
  current = worker;
}

export function wakeWorker(): void {
  current?.wake();
}
