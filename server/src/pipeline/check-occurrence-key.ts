// Check for the calendar occurrence key (SAA-331): what matchRecording stores in
// recordings.occurrence_key, occurrence_key_rule and calendar_event_id.
//
// Real match runs (matchRecording, the code a match job calls) against a scratch
// database, with Google answered in this process: fetch is wrapped so each
// member's access token gets that member's own copy of the calendar. The copies
// differ the way two attendees' copies can: their own event ids and series ids,
// and times stated in different zones. Nothing reaches Google.
//
//   1  two members, each matched to their own calendar's copy of the same
//      occurrence, store the same key; another occurrence of the same series
//      stores a different key; a moved occurrence keeps its original key; a
//      one-off event's key is its iCalUID; an occurrence with no
//      originalStartTime falls back to its start and says so; no match stores
//      null; the key is plain in SQL (not call text)
//   2  a re-match that picks another event replaces the key, the rule and the
//      event id; one that finds no event in range clears all three; one that
//      cannot reach a calendar (no connection) leaves them as they were
//   3  the database's CHECK: a key with no rule is refused, a key with a rule is
//      accepted (each in a transaction rolled back)
//
//   scripts/scratch-db.sh run check-occurrence-key

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { titlePlaceholderFor } from "../ingest/clipwise.js";
import { encrypt } from "../lib/crypto.js";
import type { CalendarEvent } from "../lib/google-calendar.js";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { matchRecording, occurrenceKeyOf } from "./match-calendar.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures++;
}

const SERIES_UID = "series-uid@clipwise.test";
const ONE_OFF_UID = "one-off-uid@clipwise.test";
const OTHER_UID = "other-uid@clipwise.test";

// Member A's and member B's copies of one weekly series. B states times in
// -05:00; A in Z. Event ids and series ids differ per calendar on purpose.
function seriesCopy(owner: "a" | "b", n: number, originalUtc: string, startUtc = originalUtc): CalendarEvent {
  const zone = (iso: string) => (owner === "b" ? new Date(new Date(iso).getTime() - 5 * 3600_000).toISOString().replace(".000Z", "-05:00") : iso);
  return {
    id: `series-${owner}_${n}`,
    iCalUID: SERIES_UID,
    recurringEventId: `series-${owner}`,
    start: { dateTime: zone(startUtc) },
    originalStartTime: { dateTime: zone(originalUtc) },
  };
}

type Stored = { key: string | null; rule: string | null; eventId: string | null };
async function stored(recordingId: string): Promise<Stored> {
  const [r] = await db
    .select({ key: schema.recordings.occurrenceKey, rule: schema.recordings.occurrenceKeyRule, eventId: schema.recordings.calendarEventId })
    .from(schema.recordings)
    .where(eq(schema.recordings.id, recordingId));
  return { key: r?.key ?? null, rule: r?.rule ?? null, eventId: r?.eventId ?? null };
}
const show = (s: Stored) => JSON.stringify(s);

async function main(): Promise<void> {
  await refuseUnlessScratch("check-occurrence-key");
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const fx = await makeAccount("check-occurrence-key");
  const realFetch = globalThis.fetch;
  try {
    // ---- the calendars, by access token ----
    const calendars: Record<string, CalendarEvent[]> = {
      "token-a": [
        seriesCopy("a", 1, "2026-11-02T15:00:00.000Z"),
        seriesCopy("a", 2, "2026-11-09T15:00:00.000Z"),
        // Occurrence 3 moved from 15:00 to 16:30 on A's calendar.
        seriesCopy("a", 3, "2026-11-16T15:00:00.000Z", "2026-11-16T16:30:00.000Z"),
        { id: "one-off-a", iCalUID: ONE_OFF_UID, start: { dateTime: "2026-11-03T12:00:00.000Z" } },
        // An occurrence that came without originalStartTime.
        { id: "bare-a_1", iCalUID: "bare-uid@clipwise.test", recurringEventId: "bare-a", start: { dateTime: "2026-11-04T09:00:00.000Z" } },
      ],
      "token-b": [seriesCopy("b", 1, "2026-11-02T15:00:00.000Z"), seriesCopy("b", 2, "2026-11-09T15:00:00.000Z")],
    };
    let calendarCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/")) {
        calendarCalls++;
        const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
        return Response.json({ items: calendars[token] ?? [] });
      }
      throw new Error(`check-occurrence-key: unexpected fetch ${url.split("?")[0]}`);
    }) as typeof fetch;

    const member = async (who: string): Promise<string> => {
      const [m] = await db
        .insert(schema.accountMembers)
        .values({ accountId: fx.accountId, email: `${who}-${fx.tag}@clipwise.test`, role: "member", joinedAt: new Date() })
        .returning({ id: schema.accountMembers.id });
      return m.id;
    };
    const connect = (memberId: string, token: string) =>
      db.insert(schema.calendarConnections).values({
        accountId: fx.accountId,
        memberId,
        calendarEmail: `${token}-${fx.tag}@clipwise.test`,
        accessToken: encrypt(token),
        refreshToken: encrypt(`${token}-refresh`),
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        scope: "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        searchedCalendarIds: [`${token}-cal-${fx.tag}@clipwise.test`],
      });
    const recording = async (owner: string, stem: string, startedAt: string): Promise<string> => {
      const id = await makeRecording(fx, { segments: 0 });
      await db
        .update(schema.recordings)
        .set({ ownerMemberId: owner, startedAt: new Date(startedAt), title: titlePlaceholderFor(stem), metadata: { capture: { stem } } })
        .where(eq(schema.recordings.id, id));
      return id;
    };

    const mA = await member("a");
    const mB = await member("b");
    await connect(mA, "token-a");
    await connect(mB, "token-b");

    const rA = await recording(mA, "check-ok-a", "2026-11-02T15:00:20Z");
    const rB = await recording(mB, "check-ok-b", "2026-11-02T15:00:45Z");
    const rC = await recording(mA, "check-ok-c", "2026-11-09T15:00:10Z");
    const rM = await recording(mA, "check-ok-m", "2026-11-16T16:30:05Z");
    const rO = await recording(mA, "check-ok-o", "2026-11-03T12:01:00Z");
    const rF = await recording(mA, "check-ok-f", "2026-11-04T09:00:30Z");
    const rN = await recording(mA, "check-ok-n", "2026-11-20T09:00:00Z");

    const results: Record<string, string> = {};
    for (const [name, id] of Object.entries({ rA, rB, rC, rM, rO, rF, rN })) {
      const r = await matchRecording(id);
      results[name] = r.matched ? "matched" : r.reason;
    }
    process.stdout.write(`match results: ${JSON.stringify(results)}; calendar calls: ${calendarCalls}\n`);

    // ---- 1 ----
    const [a, b, c, m, o, f, n] = await Promise.all([rA, rB, rC, rM, rO, rF, rN].map(stored));
    for (const [name, s] of Object.entries({ rA: a, rB: b, rC: c, rM: m, rO: o, rF: f, rN: n })) process.stdout.write(`  ${name} ${show(s)}\n`);
    check(
      "1 control: the two copies of occurrence 1 differ in event id and stated time zone, so a match on id or raw text would not link them",
      a.eventId !== null && b.eventId !== null && a.eventId !== b.eventId &&
        calendars["token-a"][0].originalStartTime?.dateTime !== calendars["token-b"][0].originalStartTime?.dateTime,
      `${a.eventId} vs ${b.eventId}`,
    );
    check(
      "1 two members, each matched to their own copy of the same occurrence, store the same key",
      a.key !== null && a.key === b.key && a.key === `${SERIES_UID}|2026-11-02T15:00:00.000Z` && a.rule === "original_start" && b.rule === "original_start",
      `${a.key} / ${b.key}`,
    );
    check("1 a different occurrence of the same series stores a different key", c.key === `${SERIES_UID}|2026-11-09T15:00:00.000Z` && c.key !== a.key, String(c.key));
    check(
      "1 a moved occurrence (15:00 moved to 16:30) keeps its original key",
      m.key === `${SERIES_UID}|2026-11-16T15:00:00.000Z` && m.rule === "original_start" && m.eventId === "series-a_3",
      show(m),
    );
    check("1 a one-off event's key is its iCalUID", o.key === ONE_OFF_UID && o.rule === "one_off", show(o));
    check(
      "1 an occurrence with no originalStartTime falls back to its start, and the rule says so",
      f.key === "bare-uid@clipwise.test|2026-11-04T09:00:00.000Z" && f.rule === "start_fallback",
      show(f),
    );
    check("1 no match stores null key, rule and event id", results.rN === "no_event_in_range" && n.key === null && n.rule === null && n.eventId === null, `${results.rN} ${show(n)}`);
    const raw = (await pool.query<{ k: string | null }>("select occurrence_key as k from recordings where id = $1", [rA])).rows[0]?.k;
    check("1 the key is plain in SQL (not call text): a raw read equals it", raw != null && raw === a.key && !raw.startsWith("cw1:"), String(raw));
    check(
      "1 the key function alone agrees (pure occurrenceKeyOf, no database)",
      occurrenceKeyOf(calendars["token-b"][1])?.key === c.key && occurrenceKeyOf({ id: "x", start: { dateTime: "2026-11-02T15:00:00Z" } }) === null,
    );

    // ---- 2 ----
    // A's calendar now has a different event at occurrence 1's time.
    calendars["token-a"] = [{ id: "other-a", iCalUID: OTHER_UID, start: { dateTime: "2026-11-02T15:00:00.000Z" } }, ...calendars["token-a"].slice(1)];
    await matchRecording(rA);
    const a2 = await stored(rA);
    check("2 a re-match that picks another event replaces the key, the rule and the event id", a2.key === OTHER_UID && a2.rule === "one_off" && a2.eventId === "other-a", show(a2));
    check("2 control: the other member's copy is untouched", show(await stored(rB)) === show(b), show(await stored(rB)));

    calendars["token-a"] = calendars["token-a"].slice(1);
    const r3 = await matchRecording(rA);
    const a3 = await stored(rA);
    check(
      "2 a re-match that finds no event in range clears the key, the rule and the event id",
      !r3.matched && r3.reason === "no_event_in_range" && a3.key === null && a3.rule === null && a3.eventId === null,
      `${r3.matched ? "matched" : r3.reason} ${show(a3)}`,
    );

    await db.delete(schema.calendarConnections).where(eq(schema.calendarConnections.memberId, mA));
    const r4 = await matchRecording(rC);
    const c4 = await stored(rC);
    check(
      "2 a re-match that cannot reach a calendar (no connection) leaves the stored occurrence as it was",
      !r4.matched && r4.reason === "not_connected" && show(c4) === show(c),
      `${r4.matched ? "matched" : r4.reason} ${show(c4)}`,
    );

    // ---- 3 ----
    const insertWith = async (key: string | null, rule: string | null): Promise<{ code: string; constraint: string }> => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        try {
          await client.query(
            "insert into recordings (account_id, slug, source, source_id, occurrence_key, occurrence_key_rule) values ($1, $2, 'check', $3, $4, $5)",
            [fx.accountId, `check-ok-${randomBytes(6).toString("hex")}`, randomBytes(6).toString("hex"), key, rule],
          );
          return { code: "accepted", constraint: "" };
        } catch (err) {
          const e = err as { code?: string; constraint?: string };
          return { code: e.code ?? "?", constraint: e.constraint ?? "" };
        } finally {
          await client.query("rollback");
        }
      } finally {
        client.release();
      }
    };
    const refused = await insertWith("k@clipwise.test", null);
    check(
      "3 the CHECK refuses a key with no rule",
      refused.code === "23514" && refused.constraint === "recordings_occurrence_key_rule_valid",
      `${refused.code} ${refused.constraint || "-"}`,
    );
    const ruleAlone = await insertWith(null, "one_off");
    check("3 the CHECK refuses a rule with no key", ruleAlone.code === "23514" && ruleAlone.constraint === "recordings_occurrence_key_rule_valid", `${ruleAlone.code} ${ruleAlone.constraint || "-"}`);
    const accepted = await insertWith("k@clipwise.test", "one_off");
    check("3 control: the CHECK accepts a key with its rule (rolled back)", accepted.code === "accepted", accepted.code);
  } finally {
    globalThis.fetch = realFetch;
    await dropAccount(fx);
    await endPool();
  }
  process.stdout.write(failures === 0 ? "\ncheck-occurrence-key: all passed\n" : `\ncheck-occurrence-key: ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`check-occurrence-key: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
  process.exit(1);
});
