// Check that extraction logs no words of a call (SAA-227 decision 3).
//
// The real extraction path (runExtraction: both passes, collapse, the retry and
// failure branches) runs against a database, with the real Anthropic SDK on a
// stub fetch that plants a known phrase in every span label and moment title, and
// in an attendee's name. Every console method and every direct write to stdout or
// stderr is captured for the whole run (the check's own lines are kept out). The
// phrase must be in no line, and in no error message that leaves runExtraction.
//
// Positive control, inside the same run: the phrase is in the stub's replies and
// in the moments written to the database, so it did reach the code.
//
// Scenarios, each reaching a different log line:
//   A. a normal run: one moment out of its span's range (warns with its title),
//      one span with no moments (logs its label)
//   B. a span whose first reply has the wrong shape (warns with the reply)
//   C. a span whose every reply has the wrong shape (throws)
//   D. the identity and voice-naming describe lines (describeRows,
//      describeMapping, describeVoiceNaming), with planted names
//   E. the calendar paths (SAA-227 part F), through real match jobs on a
//      JobWorker and the connect callback on the real app with a signed-in
//      session: a match whose recording title is placeholder-shaped for another
//      stem (the mismatch warning) and whose event has an invitee with no email,
//      a calendar that answers 401, a token refresh that is refused, and a
//      calendarList. The phrase is in the event title, invitee names and
//      addresses, calendar addresses and names, and Google's error bodies; it
//      must be in no line and in no job's last_error
//
//   scripts/scratch-db.sh run check-log-content

import { eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { buildApp } from "../app.js";
import { createPasswordLogin } from "../auth/members.js";
import { db, pool, schema } from "../db/index.js";
import { titlePlaceholderFor } from "../ingest/clipwise.js";
import { enqueueJob } from "../jobs/enqueue.js";
import { JobWorker } from "../jobs/worker.js";
import { encrypt } from "../lib/crypto.js";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "./fixtures-for-checks.js";
import { runExtraction } from "./extract.js";
import { applyIdentity, applySpeakerNames, describeMapping, describeRows, type IdentityAnswer } from "../ingest/identity.js";
import { applyVoiceNames, describeVoiceNaming, type VoiceNamesAnswer } from "../ingest/voice-names.js";
import { defaultPass2Moments, makeStubModel } from "./stub-model.js";

const PHRASE = "PURPLE-ELEPHANT-4417";
// The check's own lines go out through the original stdout.write, taken before
// anything is patched, so they are never in the scan.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const say = (s: string): void => {
  realStdoutWrite(`${s}\n`);
};
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  say(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

// Everything the code prints, captured: console.log, info, warn, error and
// debug, and direct writes to process.stdout and process.stderr.
function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const take = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "));
  };
  const takeWrite = ((chunk: unknown): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  console.log = take;
  console.info = take;
  console.warn = take;
  console.error = take;
  console.debug = take;
  process.stdout.write = takeWrite;
  process.stderr.write = takeWrite;
  return {
    lines,
    stop: () => {
      Object.assign(console, savedConsole);
      process.stdout.write = savedOut;
      process.stderr.write = savedErr;
    },
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-log-content");
  const fx = await makeAccount("check-log-content");
  try {
    const segments = 6;

    // A. normal run with an out-of-range moment and an empty span.
    const a = await makeRecording(fx, { segments, attendeeName: `${PHRASE} Attendee` });
    const stubA = makeStubModel({
      segmentCount: segments,
      phrase: PHRASE,
      pass2Moments: (span, _attempt) => {
        if (span.index === 1) return [];
        const ms = defaultPass2Moments(span, PHRASE) as { start_sec: number; end_sec: number }[];
        ms[0].end_sec = span.endSec + 500;
        return ms;
      },
    });
    let logs = captureLogs();
    let resultA: Awaited<ReturnType<typeof runExtraction>> | null = null;
    try {
      resultA = await runExtraction(a, { client: stubA.client });
    } finally {
      logs.stop();
    }
    const linesA = logs.lines;
    const rowsA = await db.select({ title: schema.moments.title }).from(schema.moments).where(sql`recording_id = ${a}`);
    check("A positive control: the planted phrase reached the code (stub replied with it, moments in the database carry it)", rowsA.length > 0 && rowsA.every((r) => r.title?.includes(PHRASE)), `rows=${rowsA.length}`);
    check("A positive control: the run exercised the out-of-range and the empty-span branches", resultA !== null && resultA.outOfRangeCount > 0 && resultA.spansYieldingZeroMoments.length > 0, JSON.stringify({ oor: resultA?.outOfRangeCount, zero: resultA?.spansYieldingZeroMoments.length }));
    check("A positive control: the capture saw log lines", linesA.length > 10, `lines=${linesA.length}`);
    check("A no log line holds the phrase", !linesA.some((l) => l.includes(PHRASE)), linesA.filter((l) => l.includes(PHRASE)).join("\n     "));

    // B. a bad shape once, then good.
    const b = await makeRecording(fx, { segments });
    const stubB = makeStubModel({
      segmentCount: segments,
      phrase: PHRASE,
      pass2Moments: (span, attempt) => (span.index === 0 && attempt === 1 ? { oops: `${PHRASE} not a list` } : defaultPass2Moments(span, PHRASE)),
    });
    logs = captureLogs();
    try {
      await runExtraction(b, { client: stubB.client });
    } finally {
      logs.stop();
    }
    check("B positive control: the bad-shape branch ran (a retry warning was logged)", logs.lines.some((l) => /attempt 1\/3/.test(l)), logs.lines.join(" | ").slice(0, 300));
    check("B no log line holds the phrase", !logs.lines.some((l) => l.includes(PHRASE)), logs.lines.filter((l) => l.includes(PHRASE)).join("\n     "));

    // C. every reply the wrong shape: it throws; neither the log nor the error may hold the phrase.
    const c = await makeRecording(fx, { segments });
    const stubC = makeStubModel({
      segmentCount: segments,
      phrase: PHRASE,
      pass2Moments: () => ({ oops: `${PHRASE} not a list` }),
    });
    logs = captureLogs();
    let thrown: unknown = null;
    try {
      await runExtraction(c, { client: stubC.client });
    } catch (err) {
      thrown = err;
    } finally {
      logs.stop();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    check("C positive control: it threw", thrown !== null, "no error");
    check("C no log line holds the phrase", !logs.lines.some((l) => l.includes(PHRASE)), logs.lines.filter((l) => l.includes(PHRASE)).join("\n     "));
    check("C the thrown error message holds no phrase", !message.includes(PHRASE), message);

    // D. the identity and voice-naming log lines (SAA-227 decision 6): the real
    // apply functions write planted names, then each describe function's output
    // is logged the way its callers log it. A second pass makes the skip branches
    // run, whose reasons quote the name already there.
    // Voice naming gets its own recording: a one-guest identity answer merges
    // Voice rows back into `them`, which would leave nothing to name.
    const d = await makeRecording(fx, { segments });
    const e = await makeRecording(fx, { segments });
    await db.insert(schema.speakers).values([
      { recordingId: e, label: "Voice 1" },
      { recordingId: e, label: "Voice 2" },
    ]);
    const answer: IdentityAnswer = { self: { name: `${PHRASE} Host` }, guests: [{ name: `${PHRASE} Guest` }] };
    const voices = (n: number): VoiceNamesAnswer => ({
      answered_at: `2026-10-11T00:00:0${n}Z`,
      voices: [{ voiceIndex: 1, name: `${PHRASE} Voice ${n}` }, { voiceIndex: 2, name: null }, { voiceIndex: 3, name: `${PHRASE} Nobody` }],
    });
    const inputs: string[] = [];
    logs = captureLogs();
    try {
      for (const n of [1, 2]) {
        const rows = await applyIdentity(db, d, answer);
        const mapping = await applySpeakerNames(db, d, answer);
        const naming = await applyVoiceNames(db, e, voices(n));
        inputs.push(JSON.stringify(n === 1 ? rows.inserted : rows.skipped), JSON.stringify(mapping), JSON.stringify(naming));
        console.log(`apply-identity: inserted=${describeRows(rows.inserted)} already_present=${describeRows(rows.skipped)}`);
        console.log(`apply-identity: speaker names ${describeMapping(mapping)}`);
        console.log(`apply-voice-names: ${describeVoiceNaming(naming)}`);
      }
    } finally {
      logs.stop();
    }
    const describeLines = logs.lines.filter((l) => /^apply-(identity|voice-names): /.test(l));
    check(
      "D positive control: the planted names reached every describe input (inserted, already present, applied, skipped)",
      inputs.length === 6 && inputs.every((s) => s.includes(PHRASE)) && /already named/.test(inputs[4]) && /already named/.test(inputs[5]),
      inputs.map((s) => (s.includes(PHRASE) ? "has" : "lacks")).join(" "),
    );
    check("D positive control: six describe lines were logged", describeLines.length === 6, `lines=${describeLines.length}`);
    const dHits = logs.lines.filter((l) => l.includes(PHRASE));
    say(`     D lines holding the phrase: ${dHits.length}`);
    check("D no log line holds the phrase", dHits.length === 0, dHits.join("\n     "));

    // E. the calendar paths (SAA-227 part F, decisions 11 and 21), run the way the
    // server runs them: real match jobs on a JobWorker, and the connect callback on
    // the real app with a signed-in session. Google is answered in this process
    // (fetch wrapped for this scenario only), with the phrase in an event's title,
    // an invitee's name, invitee and calendar addresses, a calendarList, and
    // Google's error bodies. Addresses carry it in lower case, so the scan for E
    // ignores case.
    const low = PHRASE.toLowerCase();
    const holds = (s: string | null | undefined): boolean => !!s && s.toLowerCase().includes(low);
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.GOOGLE_CLIENT_ID = "check-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "check-placeholder";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/oauth/google/callback`;
    const eStart = new Date("2026-10-12T15:00:00.000Z");
    const served: string[] = [];
    let callbackMemberEmail = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (form.get("grant_type") === "refresh_token") {
          // E5's grant is refused for good (invalid_grant: the connection is
          // removed, SAA-198 step 5); E3's fails another way (500), so its job
          // still fails and the failure path's lines still run.
          if (form.get("refresh_token") === "e-revoked-token-refresh") {
            served.push("refresh 400 invalid_grant");
            return new Response(JSON.stringify({ error: "invalid_grant", error_description: `${PHRASE} token for ${low}-cal@clipwise.test revoked` }), { status: 400 });
          }
          served.push("refresh 500");
          return new Response(JSON.stringify({ error: "server_error", error_description: `${PHRASE} backend error for ${low}-cal@clipwise.test` }), { status: 500 });
        }
        served.push("exchange 200");
        return Response.json({ access_token: "e-callback-token", refresh_token: "e-callback-refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.readonly" });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) {
        served.push("calendarList 200");
        return Response.json({
          items: [
            { id: callbackMemberEmail, primary: true, accessRole: "owner", summary: `${PHRASE} primary` },
            { id: `${low}-shared@clipwise.test`, accessRole: "reader", summary: `${PHRASE} shared` },
            { id: `${low}#holiday@group.v.calendar.google.com`, accessRole: "reader", summary: `${PHRASE} holidays` },
            { id: `${low}-busy@clipwise.test`, accessRole: "freeBusyReader", summary: `${PHRASE} busy` },
          ],
        });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/")) {
        if (token === "e-denied-token") {
          served.push("events 401");
          return new Response(JSON.stringify({ error: { code: 401, message: `${PHRASE}: calendar ${low}-cal@clipwise.test is not shared with you` } }), { status: 401 });
        }
        served.push("events 200");
        return Response.json({
          items: [
            {
              id: "e-event-1",
              summary: `${PHRASE} planning`,
              start: { dateTime: new Date(eStart.getTime() + 30_000).toISOString() },
              attendees: [
                { email: `${low}-guest@clipwise.test`, displayName: `${PHRASE} Guest`, responseStatus: "accepted" },
                { displayName: `${PHRASE} Room` },
              ],
            },
          ],
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const eMember = async (who: string, email?: string): Promise<string> => {
      const [m] = await db
        .insert(schema.accountMembers)
        .values({ accountId: fx.accountId, email: email ?? `${who}-${fx.tag}@clipwise.test`, role: "member", joinedAt: new Date() })
        .returning({ id: schema.accountMembers.id });
      return m.id;
    };
    const eConnect = (memberId: string, token: string, expired: boolean) =>
      db.insert(schema.calendarConnections).values({
        accountId: fx.accountId,
        memberId,
        calendarEmail: `${low}-${token}-${fx.tag}@clipwise.test`,
        accessToken: encrypt(token),
        refreshToken: encrypt(`${token}-refresh`),
        tokenExpiresAt: new Date(Date.now() + (expired ? -60_000 : 60 * 60 * 1000)),
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        searchedCalendarIds: [`${low}-cal-${fx.tag}@clipwise.test`],
      });
    const eRecording = async (ownerMemberId: string, stem: string, title: string): Promise<string> => {
      const id = await makeRecording(fx, { segments: 1 });
      await db.update(schema.recordings).set({ ownerMemberId, startedAt: eStart, title, metadata: { capture: { stem } } }).where(eq(schema.recordings.id, id));
      return id;
    };

    const mOk = fx.memberId;
    const mDenied = await eMember("e-denied");
    const mExpired = await eMember("e-expired");
    const mRevoked = await eMember("e-revoked");
    await eConnect(mOk, "e-ok-token", false);
    await eConnect(mDenied, "e-denied-token", false);
    await eConnect(mExpired, "e-expired-token", true);
    await eConnect(mRevoked, "e-revoked-token", true);
    const connectionOf = async (memberId: string) =>
      (await db.select({ id: schema.calendarConnections.id }).from(schema.calendarConnections).where(eq(schema.calendarConnections.memberId, memberId)))[0]?.id ?? null;
    const revokedConnectionId = await connectionOf(mRevoked);
    // E1's title is placeholder-shaped for another stem, so the mismatch warning
    // runs; it quoted both titles before.
    const e1 = await eRecording(mOk, "check-e1", titlePlaceholderFor(`${PHRASE}-other-stem`));
    const e2 = await eRecording(mDenied, "check-e2", titlePlaceholderFor("check-e2"));
    const e3 = await eRecording(mExpired, "check-e3", titlePlaceholderFor("check-e3"));
    const e5 = await eRecording(mRevoked, "check-e5", titlePlaceholderFor("check-e5"));
    const eJobs: string[] = [];
    for (const rec of [e1, e2, e3, e5]) {
      const id = await enqueueJob(db, { accountId: fx.accountId, recordingId: rec, kind: "match" });
      if (id) eJobs.push(id);
    }
    const worker = new JobWorker({ renewMs: 200, leaseMs: 10_000, maxAttempts: 1, backoffMs: [0] });
    type JobState = { id: string; recording_id: string; state: string; error_class: string | null; last_error: string | null };
    let jobRows: JobState[] = [];
    logs = captureLogs();
    try {
      worker.wake();
      const t0 = Date.now();
      for (;;) {
        jobRows = (await pool.query<JobState>("select id, recording_id, state, error_class, last_error from jobs where id = any($1::uuid[])", [eJobs])).rows;
        if (jobRows.length === eJobs.length && jobRows.every((j) => j.state === "done" || j.state === "failed")) break;
        if (Date.now() - t0 > 30_000) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await worker.stop();
    } finally {
      logs.stop();
    }
    const jobLines = logs.lines;
    const jobOf = (rec: string) => jobRows.find((j) => j.recording_id === rec);
    const e1Invitees = await db.select({ email: schema.invitees.email, name: schema.invitees.name }).from(schema.invitees).where(eq(schema.invitees.recordingId, e1));
    const e1Title = (await db.select({ title: schema.recordings.title }).from(schema.recordings).where(eq(schema.recordings.id, e1)))[0]?.title;
    check(
      "E positive control: the three match jobs ran: E1 done with the planted invitee stored and its title left alone (placeholder mismatch), E2 failed on the 401, E3 failed on the refresh",
      jobOf(e1)?.state === "done" && e1Invitees.length === 1 && holds(e1Invitees[0].email) && holds(e1Invitees[0].name) && holds(e1Title) &&
        jobOf(e2)?.state === "failed" && jobOf(e2)?.error_class === "CalendarFetchError" &&
        jobOf(e3)?.state === "failed" && jobOf(e3)?.error_class === "GoogleApiError",
      JSON.stringify({ jobs: jobRows.map((j) => [j.recording_id === e1 ? "E1" : j.recording_id === e2 ? "E2" : j.recording_id === e3 ? "E3" : "E5", j.state, j.error_class]), invitees: e1Invitees.length }),
    );
    check(
      "E positive control: Google was asked for E1's events, E2's (401), E3's refresh (500) and E5's (400 invalid_grant), each with the phrase in its reply",
      ["events 200", "events 401", "refresh 500", "refresh 400 invalid_grant"].every((s) => served.includes(s)),
      served.join(", "),
    );
    // E5. A refresh Google refuses with invalid_grant (SAA-198 step 5): the job is
    // done, the connection is gone, and the one line it logs names the member
    // and the connection by id, never the address or a token. E3, refused another
    // way, keeps its connection (the control).
    const revokedLines = jobLines.filter((l) => /refresh refused \(invalid_grant\)/.test(l));
    check(
      "E5 invalid_grant: the job is done and the connection removed; E3's (500) is kept (the control)",
      jobOf(e5)?.state === "done" && (await connectionOf(mRevoked)) === null && (await connectionOf(mExpired)) !== null,
      JSON.stringify({ e5: jobOf(e5)?.state, e5Connection: await connectionOf(mRevoked), e3Connection: !!(await connectionOf(mExpired)) }),
    );
    check(
      "E5 positive control: the removal line ran once, naming the member and the connection by id",
      revokedLines.length === 1 && revokedLines[0].includes(`member=${mRevoked}`) && !!revokedConnectionId && revokedLines[0].includes(revokedConnectionId),
      revokedLines.join("\n     ") || "(no line)",
    );
    check(
      "E5 the removal line holds ids only: no address, no phrase, no token",
      revokedLines.length === 1 && !holds(revokedLines[0]) && !/@/.test(revokedLines[0]) && !/e-revoked-token/.test(revokedLines[0]),
      revokedLines.join("\n     ") || "(no line)",
    );
    check(
      "E positive control: the job lines ran: the worker's match line, the placeholder mismatch warning, the skipped-invitee line and the fetch-failure warning",
      jobLines.some((l) => /calendar matched/.test(l)) && jobLines.some((l) => /placeholder mismatch/.test(l)) && jobLines.some((l) => /invitee with no email skipped/.test(l)) && jobLines.some((l) => /calendar fetch failed/.test(l)),
      `lines=${jobLines.length}`,
    );
    const eJobHits = jobLines.filter(holds);
    check("E no log line from the match jobs holds the phrase", eJobHits.length === 0, eJobHits.join("\n     "));
    const errorHits = jobRows.filter((j) => holds(j.last_error));
    check("E no job's last_error holds the phrase (Google's reply stays out)", errorHits.length === 0, errorHits.map((j) => j.last_error).join("\n     "));

    // E4. the connect callback: a member signs in with a password on the real app,
    // connects, and Google's calendarList (planted) is read and stored.
    callbackMemberEmail = `${low}-${fx.tag}@clipwise.test`;
    const mCallback = await eMember("e-callback", callbackMemberEmail);
    const ePassword = `pw-${randomBytes(9).toString("base64url")}`;
    await createPasswordLogin(callbackMemberEmail, "E Callback", ePassword);
    const { app } = await buildApp();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
    let callbackStatus = 0;
    logs = captureLogs();
    try {
      const signIn = await realFetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: callbackMemberEmail, password: ePassword }),
      });
      const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const start = await realFetch(`${base}/oauth/google/connect`, { headers: { origin, cookie }, redirect: "manual" });
      const state = new URL(start.headers.get("location") ?? "http://x/").searchParams.get("state") ?? "";
      const cb = await realFetch(`${base}/oauth/google/callback?code=e-code&state=${encodeURIComponent(state)}`, { headers: { origin, cookie }, redirect: "manual" });
      callbackStatus = cb.status;
      await cb.arrayBuffer();
    } finally {
      logs.stop();
      await new Promise((r) => server.close(() => r(null)));
    }
    const cbRows = await db.select({ searched: schema.calendarConnections.searchedCalendarIds }).from(schema.calendarConnections).where(eq(schema.calendarConnections.memberId, mCallback));
    check(
      "E4 positive control: the callback read the planted calendarList and stored the member's connection, its searched calendars carrying the phrase",
      callbackStatus === 200 && served.includes("calendarList 200") && cbRows.length === 1 && (cbRows[0].searched ?? []).some(holds),
      JSON.stringify({ status: callbackStatus, rows: cbRows.length }),
    );
    check("E4 positive control: both callback log lines ran", logs.lines.some((l) => /calendarList for/.test(l)) && logs.lines.some((l) => /searchable calendars for/.test(l)), `lines=${logs.lines.length}`);
    const cbHits = logs.lines.filter(holds);
    check("E4 no log line from the callback holds the phrase", cbHits.length === 0, cbHits.join("\n     "));
    globalThis.fetch = realFetch;

    await db.delete(schema.moments).where(inArray(schema.moments.recordingId, [a, b, c]));
  } finally {
    await pool.query(`delete from auth_session where "userId" in (select id from auth_user where email like $1)`, [`%-${fx.tag}@clipwise.test`]);
    await pool.query(`delete from auth_account where "userId" in (select id from auth_user where email like $1)`, [`%-${fx.tag}@clipwise.test`]);
    await pool.query(`delete from auth_user where email like $1`, [`%-${fx.tag}@clipwise.test`]);
    await dropAccount(fx);
    await endPool();
  }
  say(failures === 0 ? "\ncheck-log-content: all passed" : `\ncheck-log-content: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  say(`check-log-content: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
