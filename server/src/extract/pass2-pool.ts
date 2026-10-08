// Bounded concurrency for pass 2's per-topic calls (SAA-239 stage 1).
//
// Kept apart from extract.ts so it holds no database import and can be
// exercised with stub work functions (check-pass2-pool.ts).
//
// What it promises, and extract.ts relies on:
//   - Results come back indexed by item position, whatever order the calls
//     finish in. Nothing downstream ever sees completion order.
//   - The first item runs alone. Every call carries the whole transcript as a
//     cached prefix; started together, six calls would each write that cache
//     instead of one writing it and the rest reading it.
//   - The first failure that is not a push-back stops new work, aborts the
//     calls in flight, and rejects with that first error, the same error the
//     sequential loop threw. No partial result is returned.
//   - A push-back (429, or a 5xx such as 529 overloaded) that still reaches
//     here after the SDK's own retries halves the ceiling (floor 1) and puts
//     the item back in the queue, a bounded number of times per item. These
//     requeues are counted apart from runPass2's bad-shape attempts.

export type PoolOptions = {
  // Most calls in flight once the first has finished.
  cap: number;
  // Requeues allowed per item after a push-back reaches the pool.
  maxRequeues: number;
  // Wait before a requeued item goes back in the queue, in ms; n is 1 for
  // that item's first requeue. The slot is held while waiting.
  backoffMs: (n: number) => number;
  isPushback: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRequeue?: (info: { index: number; requeue: number; ceiling: number; err: unknown }) => void;
};

// The SDK retries 408, 409, 429 and every 5xx twice before throwing (client.js
// shouldRetry), so an error with one of these statuses here means it already
// spent those retries.
export function isApiPushback(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

export function runBoundedPool<T, R>(
  items: T[],
  work: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  opts: PoolOptions,
): Promise<R[]> {
  const n = items.length;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const results = new Array<R>(n);
  const requeues = new Array<number>(n).fill(0);
  const queue = items.map((_, i) => i);
  const controller = new AbortController();
  let ceiling = Math.max(1, Math.floor(opts.cap));
  let warm = false; // set when the first item has finished
  let active = 0;
  let completed = 0;
  let failure: { err: unknown } | null = null;

  return new Promise<R[]>((resolve, reject) => {
    if (n === 0) return resolve(results);

    const pump = (): void => {
      if (failure) {
        if (active === 0) reject(failure.err);
        return;
      }
      if (completed === n) return resolve(results);
      const limit = warm ? ceiling : 1;
      while (active < limit && queue.length > 0) {
        const i = queue.shift() as number;
        active++;
        work(items[i], i, controller.signal).then(
          (r) => {
            results[i] = r;
            completed++;
            active--;
            warm = true;
            pump();
          },
          async (err) => {
            if (!failure && opts.isPushback(err) && requeues[i] < opts.maxRequeues) {
              requeues[i]++;
              ceiling = Math.max(1, Math.floor(ceiling / 2));
              opts.onRequeue?.({ index: i, requeue: requeues[i], ceiling, err });
              await sleep(opts.backoffMs(requeues[i]));
              queue.unshift(i);
              active--;
              pump();
              return;
            }
            if (!failure) {
              failure = { err };
              controller.abort();
            }
            active--;
            pump();
          },
        );
      }
    };
    pump();
  });
}
