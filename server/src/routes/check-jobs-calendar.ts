// Check for the calendar list in GET /captures/:captureId/jobs (SAA-260 11-07,
// item 7): every address of the owner's is left out, by the rule ingest uses
// (ingest/invitee-names.ts ownerAddressesFor). Real routes and the real
// database; the request's sign-in is a middleware that sets the access context
// the capture-token guard would. Addresses are made up.
//
// One capture whose calendar match is done, with five invitees and no names
// except one: the owner's sign-in address, the owner's calendar connection's
// address, the address of a calendar the connection searches (stored in another
// case, as Google may give it), a guest known only by address, and a named
// guest.
//
//   j1  control (unchanged): the sign-in address is left out
//   j2  the calendar connection's address is left out
//   j3  a searched calendar's address is left out, whatever its case
//   j4  control (unchanged): the guest with no name shows as their address,
//       the named one by name
//   j5  the list is exactly those two guests
//
//   scripts/scratch-db.sh run check-jobs-calendar

import { eq } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, pool, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { errorHandler } from "../lib/http.js";
import { captureScopeRouter } from "./capture-scope.js";
import { capturesPost } from "./captures.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

function payload(): Record<string, unknown> & { captureId: string } {
  const id = randomUUID().toUpperCase();
  const segments = [{ track: "me", startMs: 0, endMs: 1500, text: "hello" }, { track: "them", startMs: 2000, endMs: 4000, text: "hi" }];
  const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 4, gaps: [], note: "check" });
  return {
    captureId: id,
    startedAt: "2026-11-07T11:00:00.000Z",
    stem: `check-jobs-calendar-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: 7, countedFrom: "check-jobs-calendar" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-jobs-calendar");
  const fx = await makeAccount("check-jobs-calendar");
  const tag = fx.tag;
  const signIn = `check-jobs-calendar-${tag}@clipwise.test`; // makeAccount's member address
  const calendarAddress = `cal-${tag}@clipwise.test`;
  const sharedCalendar = `shared-${tag}@clipwise.test`;
  const guest = `guest-${tag}@clipwise.test`;
  const named = `named-${tag}@clipwise.test`;
  const ctx = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: signIn, scope: ["clipwise:capture"] };
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = ctx as typeof req.access;
    next();
  });
  app.post("/captures", capturesPost);
  app.use(captureScopeRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const p = payload();
    const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
    const rec = String(((await res.json()) as { recordingId?: string }).recordingId);
    // The connection: its own address, and the calendars it searches (one shared
    // in, stored in another case; one whose id is not an address).
    await db.insert(schema.calendarConnections).values({
      accountId: fx.accountId,
      memberId: fx.memberId,
      calendarEmail: calendarAddress,
      accessToken: "check-not-a-token",
      refreshToken: "check-not-a-token",
      tokenExpiresAt: new Date(),
      searchedCalendarIds: ["primary", sharedCalendar.toUpperCase()],
    });
    await db.insert(schema.invitees).values([
      { recordingId: rec, email: signIn, name: null },
      { recordingId: rec, email: calendarAddress, name: null },
      { recordingId: rec, email: sharedCalendar, name: null },
      { recordingId: rec, email: guest, name: null },
      { recordingId: rec, email: named, name: "Named Guest" },
    ]);
    // The match job, done: the route serves the calendar only then.
    await pool.query(`delete from jobs where recording_id = $1`, [rec]);
    await db.insert(schema.jobs).values({ accountId: fx.accountId, recordingId: rec, kind: "match", state: "done", attempts: 1 });

    const polled = await fetch(`${base}/captures/${p.captureId}/jobs`);
    const json = (await polled.json()) as { calendar?: { invitees?: Array<{ name: string }> } | null };
    const names = (json.calendar?.invitees ?? []).map((i) => i.name);
    const detail = `${polled.status} ${JSON.stringify(names)}`;

    check("j1: control (unchanged): the owner's sign-in address is left out", polled.status === 200 && !names.includes(signIn), detail);
    check("j2: the owner's calendar connection's address is left out", polled.status === 200 && !names.includes(calendarAddress), detail);
    check("j3: the address of a calendar the connection searches is left out, whatever its case", polled.status === 200 && !names.includes(sharedCalendar), detail);
    check(
      "j4: control (unchanged): a guest with no name shows as their address, a named one by name",
      polled.status === 200 && names.includes(guest) && names.includes("Named Guest"),
      detail,
    );
    check("j5: the list is exactly those two guests", polled.status === 200 && JSON.stringify(names) === JSON.stringify([guest, "Named Guest"]), detail);
  } finally {
    server.close();
    await db.delete(schema.calendarConnections).where(eq(schema.calendarConnections.accountId, fx.accountId));
    await dropAccount(fx);
    await endPool();
  }
  console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
