// Check for boot.ts (SAA-227 decision 8). No database.
//
// A real HTTP server on a loopback port with the gate as its listener: before
// the app is ready /live is 200 and everything else is 503 with Retry-After and
// no app behaviour; after, every request goes to the app, the route that was 503
// included, and /live is 200 throughout.
//
// Then SIGTERM to the real entry point (src/index.ts, spawned) with a database
// URL nothing answers on, sent the moment it says it is listening: it exits 0
// inside the 10 s cap, and a jobs worker that started is stopped before the exit.
// A SIGTERM sent at "listening" is handled only after the app has loaded and the
// worker has started (seen under tsx and on the built server, 2026-10-10), so the
// guards in server.ts that keep the worker from starting during a shutdown are
// not reached by this check. The control lets one load to the end first, and
// shows that a worker that did start is seen (its boot check fails on the dead
// URL) and is stopped on the way out.
//
//   npx tsx src/check-boot.ts

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGate } from "./boot.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

function request(port: number, method: string, path: string): Promise<{ status: number; retryAfter: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] as string | undefined, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const gate = createGate();
const server = http.createServer(gate.listener);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

// Before the app is ready.
const healthBefore = await request(port, "GET", "/health");
check("before ready: GET /health is 503 with Retry-After: 2", healthBefore.status === 503 && healthBefore.retryAfter === "2", JSON.stringify(healthBefore));
const live = await request(port, "GET", "/live");
check("before ready: GET /live is 200 {status:ok}", live.status === 200 && live.body === '{"status":"ok"}', JSON.stringify(live));
const liveQuery = await request(port, "GET", "/live?probe=1");
check("before ready: GET /live?probe=1 is 200", liveQuery.status === 200, JSON.stringify(liveQuery));
const liveHead = await request(port, "HEAD", "/live");
check("before ready: HEAD /live is 200 with no body", liveHead.status === 200 && liveHead.body === "", JSON.stringify(liveHead));
for (const [method, path] of [["GET", "/health"], ["POST", "/captures"], ["POST", "/mcp"], ["GET", "/login"], ["GET", "/.well-known/oauth-protected-resource"], ["POST", "/live"], ["GET", "/liveness"]] as const) {
  const r = await request(port, method, path);
  check(`before ready: ${method} ${path} is 503 with Retry-After and an empty-of-data body`, r.status === 503 && r.retryAfter === "2" && r.body === '{"error":"starting"}', JSON.stringify(r));
}
check("isReady is false before ready()", !gate.isReady());

// After: everything goes to the app, /live included.
gate.ready((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`app:${req.method}:${req.url}`);
});
const after = await request(port, "GET", "/health");
check("after ready: the same route, GET /health, reaches the app (200, the app's body, no Retry-After)", after.status === 200 && after.body === "app:GET:/health" && after.retryAfter === undefined, JSON.stringify(after));
const afterLive = await request(port, "GET", "/live");
check("after ready: /live is 200, and is the app's, not the gate's", afterLive.status === 200 && afterLive.body === "app:GET:/live", JSON.stringify(afterLive));
check("isReady is true after ready()", gate.isReady());

server.close();

// SIGTERM to the real server. `sendWhen` picks the log line after which it is
// sent; the result has every line the child wrote and how long the exit took.
const DEAD_URL = "postgres://check:check@127.0.0.1:1/none";
// A throwaway call-text key (SAA-277): the server refuses to start without one.
const TEST_KEY = randomBytes(32).toString("base64");
const TEST_KEY_ID = createHash("sha256").update(Buffer.from(TEST_KEY, "base64")).digest("hex").slice(0, 8);
function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", DATABASE_URL: DEAD_URL, CALL_TEXT_KEY: TEST_KEY, NODE_ENV: "development" };
  delete env.CALL_TEXT_KEY_ID;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}
async function sigtermServer(sendWhen: (line: string) => boolean, extraEnv: Record<string, string | undefined> = {}): Promise<{ lines: string[]; code: number | null; ms: number | null }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: childEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let sentAt = 0;
  const exited = new Promise<{ code: number | null; t: number }>((r) => child.once("exit", (code) => r({ code, t: Date.now() })));
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      lines.push(line);
      console.log(`    | ${line}`);
      if (!sentAt && sendWhen(line)) {
        sentAt = Date.now();
        child.kill("SIGTERM");
      }
    });
  }
  const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const ex = await exited;
  clearTimeout(killer);
  return { lines, code: ex.code, ms: sentAt ? ex.t - sentAt : null };
}
const workerSeen = (lines: string[]): boolean => lines.some((l) => l.startsWith("jobs: ") || l.includes("jobs worker stopped"));

const loading = await sigtermServer((l) => l.startsWith("Clipwise server listening on port"));
console.log(`SIGTERM at "listening": exit ${loading.code} after ${loading.ms ?? "-"} ms; app ready logged: ${loading.lines.some((l) => l === "Clipwise app ready")}`);
check("SIGTERM at \"listening\": exit 0 within the 10 s cap", loading.code === 0 && loading.ms !== null && loading.ms < 10_000, JSON.stringify({ code: loading.code, ms: loading.ms }));
const firstJobs = loading.lines.findIndex((l) => l.startsWith("jobs: "));
const stoppedAt = loading.lines.findIndex((l) => l.includes("jobs worker stopped"));
check("SIGTERM at \"listening\": if a jobs worker started, it is stopped before the exit", firstJobs === -1 || stoppedAt > firstJobs, loading.lines.filter((l) => l.startsWith("jobs: ") || l.startsWith("shutdown:")).join(" / "));

// Control: let the load finish and the worker start (its boot check fails on the
// dead URL), then SIGTERM. The pattern above must find this worker.
const loaded = await sigtermServer((l) => l.startsWith("jobs: boot check failed"));
console.log(`control, SIGTERM after the worker started: exit ${loaded.code} after ${loaded.ms ?? "-"} ms`);
check("control: a worker that did start is seen (the absence above is not blindness)", workerSeen(loaded.lines) && loaded.lines.some((l) => l.includes("jobs worker stopped")), loaded.lines.filter((l) => l.startsWith("jobs: ") || l.startsWith("shutdown:")).join(" / "));
check("control: with the worker started, SIGTERM does not take the \"while starting\" path and exits 0", loaded.code === 0 && !loaded.lines.some((l) => l.includes("received while starting")), JSON.stringify({ code: loaded.code }));

// The call-text key at start (SAA-277). Each run is stopped at "listening" if it
// gets that far; a refusal exits 1 before the port opens.
const listening = (lines: string[]) => lines.some((l) => l.startsWith("Clipwise server listening on port"));
const atListen = (l: string) => l.startsWith("Clipwise server listening on port");
const noKey = await sigtermServer(atListen, { CALL_TEXT_KEY: undefined });
check("no CALL_TEXT_KEY: the server refuses before it listens, exit 1, naming the variable", noKey.code === 1 && !listening(noKey.lines) && noKey.lines.some((l) => l.startsWith("startup: refused: CALL_TEXT_KEY not set")), JSON.stringify({ code: noKey.code, lines: noKey.lines.slice(0, 3) }));
check("with a key, the id is printed and the key is not", loading.lines.includes(`call text: key ${TEST_KEY_ID}`) && !loading.lines.some((l) => l.includes(TEST_KEY)), loading.lines.slice(0, 3).join(" / "));
const prodNoId = await sigtermServer(atListen, { NODE_ENV: "production" });
check("production with a key but no CALL_TEXT_KEY_ID: refused before it listens, exit 1", prodNoId.code === 1 && !listening(prodNoId.lines) && prodNoId.lines.some((l) => l.includes("CALL_TEXT_KEY_ID must be set in production")), JSON.stringify({ code: prodNoId.code, lines: prodNoId.lines.slice(0, 3) }));
const prodWrongId = await sigtermServer(atListen, { NODE_ENV: "production", CALL_TEXT_KEY_ID: TEST_KEY_ID === "00000000" ? "11111111" : "00000000" });
check("production with a CALL_TEXT_KEY_ID that is not the key's: refused, exit 1, naming both ids and not the key", prodWrongId.code === 1 && !listening(prodWrongId.lines) && prodWrongId.lines.some((l) => l.includes(`has id ${TEST_KEY_ID}`)) && !prodWrongId.lines.some((l) => l.includes(TEST_KEY)), JSON.stringify({ code: prodWrongId.code, lines: prodWrongId.lines.slice(0, 3) }));
const prodRightId = await sigtermServer(atListen, { NODE_ENV: "production", CALL_TEXT_KEY_ID: TEST_KEY_ID });
check("control: production with the key's own id starts and listens", listening(prodRightId.lines) && prodRightId.code === 0, JSON.stringify({ code: prodRightId.code, lines: prodRightId.lines.slice(0, 3) }));

console.log(failures === 0 ? "\ncheck-boot: all passed" : `\ncheck-boot: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
