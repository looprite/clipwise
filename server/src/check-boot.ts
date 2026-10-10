// Check for boot.ts (SAA-227 decision 8). No database.
//
// A real HTTP server on a loopback port with the gate as its listener: before
// the app is ready /live is 200 and everything else is 503 with Retry-After and
// no app behaviour; after, every request goes to the app, the route that was 503
// included, and /live is 200 throughout.
//
//   npx tsx src/check-boot.ts

import http from "node:http";
import type { AddressInfo } from "node:net";
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
console.log(failures === 0 ? "\ncheck-boot: all passed" : `\ncheck-boot: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
