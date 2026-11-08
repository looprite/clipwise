// Check for the access line (SAA-277 step 5): every read of call content writes
// exactly one line, `access: member=<id> route=<name> …`, naming who read which
// recordings, and nothing of the call (no text, no title, not the search words).
//
// The six read paths, through the real routers mounted as app.ts mounts them
// (behind a stand-in for the auth guards that sets the member's access context)
// and the real MCP tool handlers:
//   transcript          GET /recordings/:id/transcript
//   moment              GET /accounts/:accountId/moments/:id
//   moments.search      GET /accounts/:accountId/moments        (q, index, no match)
//   capture.transcript  GET /captures/:captureId/transcript
//   mcp.search_moments  the MCP tool
//   mcp.get_transcript  the MCP tool
// A read that finds nothing (404) writes no line. A planted phrase, in the
// recording's title, its transcript and its moments, and used as the search
// words, appears in no line written during the run; control: it is in what the
// reads returned.
//
// Writes, so it refuses unless run through scratch-db.sh on a scratch branch:
//
//   scripts/scratch-db.sh run check-access-line

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AccessContext } from "./context.js";
import { db, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { errorHandler } from "../lib/http.js";
import { TOOLS } from "../mcp/tools.js";
import { captureScopeRouter } from "../routes/capture-scope.js";
import { capturesPost } from "../routes/captures.js";
import { momentsRouter } from "../routes/moments.js";
import { transcriptRouter } from "../routes/transcript.js";

// Every line written to stdout or stderr while the check runs, the check's own
// PASS/FAIL lines excepted.
const written: string[] = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
const tap = (chunk: unknown) => {
  for (const line of String(chunk).split("\n")) if (line !== "") written.push(line);
};
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (tap(chunk), true)) as typeof process.stdout.write;
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (tap(chunk), (realErr as (c: unknown) => boolean)(chunk))) as typeof process.stderr.write;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  realOut(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}\n`);
  if (!ok) failures++;
}

// The lines one read writes, and the access lines among them.
async function during<T>(fn: () => Promise<T>): Promise<{ result: T; access: string[] }> {
  const from = written.length;
  const result = await fn();
  // The access line is written before the response is sent, so it is in by now;
  // the tick lets a write that raced the response land too.
  await new Promise((r) => setImmediate(r));
  return { result, access: written.slice(from).filter((l) => l.startsWith("access: ")) };
}

async function postCapture(ctx: AccessContext, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      status(s: number) {
        status = s;
        return res;
      },
      json(b: unknown) {
        resolve({ status, body: b });
        return res;
      },
    };
    capturesPost({ access: ctx, body } as unknown as Request, res as unknown as Response, ((err: unknown) =>
      resolve({ status: (err as { status?: number })?.status ?? 500, body: String((err as Error)?.message ?? err) })) as NextFunction);
  });
}

await refuseUnlessScratch("check-access-line");

let fx: Fixture | null = null;
let server: ReturnType<ReturnType<typeof express>["listen"]> | null = null;
try {
  fx = await makeAccount("check-access-line");
  const PHRASE = `marigold${fx.tag}anchor`;
  const ctx: AccessContext = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check-access-line", email: `check-access-line-${fx.tag}@clipwise.test`, scope: [] };
  const M = fx.memberId;

  // ---- one recording, through the recorder's path, with the phrase everywhere ----
  const captureId = randomUUID().toUpperCase();
  const segs = [{ track: "me" as const, startMs: 0, endMs: 3000, text: `the ${PHRASE} plan holds` }];
  const posted = await postCapture(ctx, {
    captureId,
    startedAt: new Date().toISOString(),
    stem: `check-access-line-${fx.tag}`,
    engine: "parakeet",
    model: "check",
    segments: segs,
    sourceFidelity: { declaredTurnCount: 1, declaredBodyChars: segs[0].text.length, countedFrom: "check-access-line" },
    classification: { verdict: "ok", concern: false, reason: "check", excludedLabels: [] },
    capture: { permissions: {}, triggerApp: null },
  });
  const R = (posted.body as { recordingId?: string } | null)?.recordingId ?? "";
  check("setup: the capture is stored (201)", posted.status === 201 && R !== "", JSON.stringify(posted));
  await db.update(schema.recordings).set({ title: `Plan review ${PHRASE}` }).where(eq(schema.recordings.id, R));
  // Two matching moments in the one recording: a search lists the recording once.
  const momentIds: string[] = [];
  for (const n of [1, 2]) {
    const [m] = await db
      .insert(schema.moments)
      .values({ accountId: fx.accountId, recordingId: R, kind: "decision", title: `${PHRASE} point ${n}`, summary: `about the ${PHRASE} plan`, startSec: n, endSec: n + 1, metadata: { source: "hand_curated" } })
      .returning({ id: schema.moments.id });
    momentIds.push(m.id);
  }

  // ---- the routers, mounted as app.ts mounts them ----
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.access = ctx;
    next();
  });
  app.use("/accounts/:accountId/moments", momentsRouter);
  app.use("/", transcriptRouter);
  app.use("/", captureScopeRouter);
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, text: await r.text() };
  };
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

  const one = (what: string, got: { access: string[] }, want: string, ok = true) =>
    check(`${what}: exactly one access line, and it is ${want}`, ok && got.access.length === 1 && got.access[0] === want, JSON.stringify(got.access));

  const t = await during(() => get(`/recordings/${R}/transcript`));
  one("GET /recordings/:id/transcript", t, `access: member=${M} route=transcript recording=${R}`, t.result.status === 200);
  const mo = await during(() => get(`/accounts/${fx!.accountId}/moments/${momentIds[0]}`));
  one("GET /accounts/:accountId/moments/:id", mo, `access: member=${M} route=moment recording=${R}`, mo.result.status === 200);
  const s = await during(() => get(`/accounts/${fx!.accountId}/moments?q=${encodeURIComponent(PHRASE)}&scope=all`));
  one("GET …/moments?q= (two matching moments, one recording)", s, `access: member=${M} route=moments.search recordings=1 ids=${R}`, s.result.status === 200);
  check("control: that search returned both moments", (JSON.parse(s.result.text).moments ?? []).length === 2, s.result.text.slice(0, 200));
  const ix = await during(() => get(`/accounts/${fx!.accountId}/moments?index=true&scope=all`));
  one("GET …/moments?index=true", ix, `access: member=${M} route=moments.search recordings=1 ids=${R}`, ix.result.status === 200);
  const none = await during(() => get(`/accounts/${fx!.accountId}/moments?q=nomatch${fx!.tag}&scope=all`));
  one("GET …/moments?q= with no match", none, `access: member=${M} route=moments.search recordings=0 ids=none`, none.result.status === 200);
  const cap = await during(() => get(`/captures/${captureId}/transcript`));
  one("GET /captures/:captureId/transcript", cap, `access: member=${M} route=capture.transcript recording=${R}`, cap.result.status === 200);
  const ms = await during(() => tool("search_moments").run(ctx, { query: PHRASE, scope: "all" }));
  one("MCP search_moments", ms, `access: member=${M} route=mcp.search_moments recordings=1 ids=${R}`);
  const mt = await during(() => tool("get_transcript").run(ctx, { recordingId: R }));
  one("MCP get_transcript", mt, `access: member=${M} route=mcp.get_transcript recording=${R}`);

  const missing = await during(() => get(`/recordings/${randomUUID()}/transcript`));
  check("a read that finds nothing (404) writes no access line", missing.result.status === 404 && missing.access.length === 0, JSON.stringify({ status: missing.result.status, access: missing.access }));

  // ---- nothing of the call in any line ----
  const responses = [t.result.text, mo.result.text, s.result.text, cap.result.text, String(ms.result), String(mt.result)];
  check("control: the phrase is in what every read returned", responses.every((r) => r.includes(PHRASE)), responses.map((r) => r.includes(PHRASE)).join(","));
  const leaked = written.filter((l) => l.includes(PHRASE) || l.includes("marigold"));
  check("the phrase is in no line written during the run (access lines and every other)", leaked.length === 0, leaked.slice(0, 3).join(" / "));
  const accessLines = written.filter((l) => l.startsWith("access: "));
  check("every access line is member, route and recording ids only", accessLines.length > 0 && accessLines.every((l) => /^access: member=[0-9a-f-]{36} route=[a-z_.]+ (recording=[0-9a-f-]{36}|recordings=\d+ ids=(none|[0-9a-f-]{36}(,[0-9a-f-]{36})*))$/.test(l)), accessLines.join(" / "));
} finally {
  if (server) await new Promise((r) => server!.close(r));
  if (fx) await dropAccount(fx);
  await endPool();
}

realOut(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
