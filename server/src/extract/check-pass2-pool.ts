// Checks for the pass 2 pool (SAA-239 stage 1): order, cap, warm-up, failure,
// push-back. Stub work functions with controlled delays; no network and no
// database (pass2-pool.ts imports neither). Plain script, exit code 0 on pass.
//
// Usage:
//   tsx src/extract/check-pass2-pool.ts
//   tsx src/extract/check-pass2-pool.ts --naive
//
// --naive swaps in a version that collects results in completion order, with
// no cap, no warm-up and no failure handling beyond Promise.all. It is the
// negative control: the cases below must fail against it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isApiPushback, runBoundedPool, type PoolOptions } from "./pass2-pool.js";

const NAIVE = process.argv.includes("--naive");

type Work<T, R> = (item: T, index: number, signal: AbortSignal) => Promise<R>;

async function naivePool<T, R>(items: T[], work: Work<T, R>): Promise<R[]> {
  const out: R[] = [];
  const ctl = new AbortController();
  await Promise.all(items.map((it, i) => work(it, i, ctl.signal).then((r) => void out.push(r))));
  return out;
}

const pool: typeof runBoundedPool = NAIVE ? (naivePool as never) : runBoundedPool;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const noSleepOpts = (over: Partial<PoolOptions> = {}): PoolOptions => ({
  cap: 6,
  maxRequeues: 3,
  backoffMs: (n) => 2000 * n,
  isPushback: isApiPushback,
  sleep: async () => {},
  ...over,
});

class StatusError extends Error {
  constructor(public status: number) {
    super(`status ${status}`);
  }
}

type Case = { name: string; run: () => Promise<string | null> }; // null = pass, string = why not

const CASES: Case[] = [
  {
    name: "results are indexed by item, not by completion order (reverse-order finish)",
    run: async () => {
      const items = [0, 1, 2, 3, 4, 5, 6, 7];
      // Item 0 is the warm-up and runs alone; the rest finish in reverse.
      const got = await pool(items, async (x, i) => {
        await wait(i === 0 ? 1 : (items.length - i) * 8);
        return x * 10;
      }, noSleepOpts());
      const want = items.map((x) => x * 10);
      return JSON.stringify(got) === JSON.stringify(want) ? null : `got ${JSON.stringify(got)}`;
    },
  },
  {
    name: "never more than cap in flight, and reaches cap (positive control)",
    run: async () => {
      let now = 0;
      let max = 0;
      await pool(Array.from({ length: 24 }, (_, i) => i), async (_x, i) => {
        now++;
        max = Math.max(max, now);
        await wait(i === 0 ? 1 : 10);
        now--;
      }, noSleepOpts({ cap: 6 }));
      return max === 6 ? null : `max in flight ${max}, wanted exactly 6`;
    },
  },
  {
    name: "warm-up: item 0 has finished before item 1 starts",
    run: async () => {
      const events: string[] = [];
      await pool([0, 1, 2, 3], async (_x, i) => {
        events.push(`start${i}`);
        await wait(i === 0 ? 20 : 2);
        events.push(`end${i}`);
      }, noSleepOpts());
      const a = events.indexOf("end0");
      const b = events.indexOf("start1");
      return a !== -1 && b !== -1 && a < b ? null : `events ${events.join(",")}`;
    },
  },
  {
    name: "a failed item rejects with that error, starts nothing new, aborts calls in flight",
    run: async () => {
      const started: number[] = [];
      const sawAbort: number[] = [];
      const boom = new Error("pass2: span boom");
      let rejected: unknown = null;
      let startedAtReject = -1;
      try {
        await pool(Array.from({ length: 20 }, (_, i) => i), async (_x, i, signal) => {
          started.push(i);
          signal.addEventListener("abort", () => sawAbort.push(i));
          if (i === 0) return wait(1);
          if (i === 3) {
            await wait(5);
            throw boom;
          }
          await wait(60);
        }, noSleepOpts({ cap: 4 }));
      } catch (e) {
        rejected = e;
        startedAtReject = started.length;
      }
      await wait(100);
      if (rejected !== boom) return `rejected with ${String(rejected)}`;
      if (started.length !== startedAtReject) return `${started.length - startedAtReject} item(s) started after the rejection`;
      if (started.length >= 20) return "every item started despite the failure";
      if (sawAbort.length === 0) return "no in-flight call saw the abort signal";
      return null;
    },
  },
  {
    name: "push-back twice then success: result kept, ceiling halves 6 -> 3 -> 1",
    run: async () => {
      const ceilings: number[] = [];
      let tries = 0;
      const got = await pool(["a", "b", "c", "d"], async (x, i) => {
        if (i === 2 && tries++ < 2) throw new StatusError(429);
        await wait(2);
        return x;
      }, noSleepOpts({ onRequeue: (r) => ceilings.push(r.ceiling) }));
      if (JSON.stringify(got) !== JSON.stringify(["a", "b", "c", "d"])) return `got ${JSON.stringify(got)}`;
      return JSON.stringify(ceilings) === "[3,1]" ? null : `ceilings ${JSON.stringify(ceilings)}`;
    },
  },
  {
    name: "after one push-back, calls started once the earlier in-flight ones are done never exceed 3",
    run: async () => {
      let tries = 0;
      let now = 0;
      const pre = new Set<number>(); // in flight when the push-back was thrown
      const inFlight = new Set<number>();
      let hit = false;
      let samples = 0;
      let maxAfter = 0;
      await pool(Array.from({ length: 24 }, (_, i) => i), async (_x, i) => {
        inFlight.add(i);
        now++;
        if (hit && pre.size === 0) {
          samples++;
          maxAfter = Math.max(maxAfter, now);
        }
        try {
          if (i === 2 && tries++ < 1) {
            await wait(3);
            hit = true;
            for (const j of inFlight) if (j !== 2) pre.add(j);
            throw new StatusError(529);
          }
          await wait(i === 0 ? 1 : 15);
        } finally {
          now--;
          inFlight.delete(i);
          pre.delete(i);
        }
      }, noSleepOpts({ cap: 6 }));
      if (samples < 6) return `only ${samples} calls started after the earlier ones finished; the case needs more`;
      if (maxAfter > 3) return `${maxAfter} in flight after the push-back, wanted at most 3`;
      return maxAfter === 3 ? null : `max ${maxAfter}, wanted it to reach 3 (positive control)`;
    },
  },
  {
    name: "push-back every time: gives up after maxRequeues, rejects with the API error",
    run: async () => {
      let calls = 0;
      let rejected: unknown = null;
      try {
        await pool([0, 1], async (_x, i) => {
          if (i === 0) {
            calls++;
            throw new StatusError(429);
          }
        }, noSleepOpts({ maxRequeues: 3 }));
      } catch (e) {
        rejected = e;
      }
      if (!(rejected instanceof StatusError) || rejected.status !== 429) return `rejected with ${String(rejected)}`;
      return calls === 4 ? null : `${calls} calls, wanted 4 (1 + 3 requeues)`;
    },
  },
  {
    name: "a 400 is not a push-back: fails at once, no requeue",
    run: async () => {
      let calls = 0;
      let rejected: unknown = null;
      try {
        await pool([0], async () => {
          calls++;
          throw new StatusError(400);
        }, noSleepOpts());
      } catch (e) {
        rejected = e;
      }
      return rejected instanceof StatusError && calls === 1 ? null : `calls ${calls}, rejected ${String(rejected)}`;
    },
  },
  {
    name: "a plain Error (bad moments shape after its attempts) is not a push-back",
    run: async () => {
      let calls = 0;
      try {
        await pool([0], async () => {
          calls++;
          throw new Error("pass2: span x — unusable moments shape after 3 attempts");
        }, noSleepOpts());
      } catch {
        /* expected */
      }
      return calls === 1 ? null : `${calls} calls`;
    },
  },
  {
    name: "empty input resolves to []; one item resolves to its result",
    run: async () => {
      const e = await pool([], async () => 1, noSleepOpts());
      const o = await pool(["x"], async (x) => x + "!", noSleepOpts());
      return e.length === 0 && o[0] === "x!" ? null : `empty ${JSON.stringify(e)} one ${JSON.stringify(o)}`;
    },
  },
  {
    name: "isApiPushback: 429, 500, 503, 529 yes; 400, 401, 404, no status, null no",
    run: async () => {
      const yes = [429, 500, 503, 529].every((s) => isApiPushback(new StatusError(s)));
      const no = [400, 401, 404].every((s) => !isApiPushback(new StatusError(s))) && !isApiPushback(new Error("x")) && !isApiPushback(null);
      return yes && no ? null : `yes ${yes} no ${no}`;
    },
  },
  {
    name: "extract.ts: nothing is inserted before the pool has returned; signal reaches the API call",
    run: async () => {
      // From src/extract (tsx) or dist/extract (compiled), the source file is
      // in src/extract either way.
      const src = readFileSync(resolve(__dirname, "..", "..", "src", "extract", "extract.ts"), "utf8");
      const poolAt = src.indexOf("await runBoundedPool(");
      const insertAt = src.indexOf(".insert(schema.moments)");
      if (poolAt === -1) return "no `await runBoundedPool(` in extract.ts";
      if (insertAt === -1) return "no moments insert found";
      if (insertAt < poolAt) return "the moments insert comes before the pool call";
      const fromPass2 = src.slice(src.indexOf("async function runPass2"));
      if (!/messages\.create\(\{[\s\S]*?\},\s*\{\s*signal\s*\}\)/.test(fromPass2))
        return "runPass2's messages.create does not pass { signal }";
      return null;
    },
  },
];

async function main(): Promise<number> {
  let failures = 0;
  for (const c of CASES) {
    let why: string | null;
    try {
      why = await c.run();
    } catch (e) {
      why = `threw ${String(e)}`;
    }
    process.stdout.write(`${why === null ? "PASS" : "FAIL"} ${c.name}${why === null ? "" : ` — ${why}`}\n`);
    if (why !== null) failures += 1;
  }
  process.stdout.write(`\n${CASES.length - failures}/${CASES.length} passed${NAIVE ? " (--naive)" : ""}\n`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
