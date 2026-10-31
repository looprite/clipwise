// Check for the calendar preview at stop and naming an invitee once (SAA-221):
// POST /captures/calendar-preview and POST /captures with inviteeNames. Real
// routes and a real (scratch) database. The request's sign-in is a middleware
// that sets the access context the capture-token guard would (as
// check-identity-correction does); app.ts's mounting is check-access's. Google
// is a stub: fetch to its two hosts answers from this file, and nothing reaches
// Google. Names and addresses are made up.
//
//   o   the owner's own addresses are in neither list: the sign-in address, the
//       connection's calendar_email, a searched calendar shared into the grant
//       (the jd@leadiq.com case) and the attendee Google marks self. Each with
//       its control: one change that makes it not the owner's, and it appears
//   n   a person in the caller's account names its address; the reply carries
//       the name and never that address. No person stays an address
//   v   a person only on another member's private recording is not named.
//       Control: once on a recording the caller owns, the same person is named
//   x   a person with the address in another account is not named. Control: the
//       same address in the caller's account is named
//   z   no match, no connection, Google failing (both calendars, or one with no
//       match), and a connection searching no calendar are each matched=false
//       with 200, and the log tells them apart: calendar_unreadable failed=2/2
//       and failed=1/2, no_searchable_calendars, against no_event_in_range when
//       both were read (the control). A preview writes nothing
//   c   a capture sent with inviteeNames creates the unnamed guest's person and
//       links the guest attendee and (on a repeat) the invitee row; names a
//       person that had none; keeps a person's existing name; refuses the owner's
//       addresses and a name with an @; a repeat writes nothing new. A later
//       preview names the guest
//   d   (SAA-260 step 2) no person has the invitee's address: exactly one
//       person with no address and the typed name is given the address and
//       reused; with two, a person is created with it, as before
//   m   the recording's whole metadata holds neither "inviteeNames" nor an @
//       (the capture's identity answer has none of its own). Control: the same
//       scan finds both planted in a copy
//   a   a guest name with an @ in the identity answer never becomes an attendee.
//       Control: the answer sent did carry it
//   l   the route's log lines (calendar-preview, invitee-names and, since
//       SAA-260 step 2, attendee-people, at least one of each) carry no @, no
//       title and no name. Control: the same scan finds each planted in a copy
//
//   scripts/scratch-db.sh run check-calendar-preview

import express from "express";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, pool, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { encrypt } from "../lib/crypto.js";
import { errorHandler } from "../lib/http.js";
import { calendarPreviewPost } from "./calendar-preview.js";
import { capturesPost } from "./captures.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

// The route's own log lines, kept for case l. Everything still prints.
const serverLines: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("calendar-preview:") || line.startsWith("invitee-names:") || line.startsWith("attendee-people:")) serverLines.push(line);
  realLog(...args);
};

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string };
const SEGMENTS: Seg[] = [
  { track: "me", startMs: 0, endMs: 1500, text: "opening" },
  { track: "them", startMs: 2000, endMs: 4000, text: "first" },
];

const EVENT_START = "2026-10-26T15:00:00Z";
const CAPTURE_START = "2026-10-26T15:00:40.000Z";

function payload(extra: Record<string, unknown>): Record<string, unknown> {
  const id = randomUUID().toUpperCase();
  const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 4, gaps: [], note: "check" });
  return {
    captureId: id,
    startedAt: CAPTURE_START,
    stem: `check-calendar-preview-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments: SEGMENTS,
    sourceFidelity: { declaredTurnCount: SEGMENTS.length, declaredBodyChars: SEGMENTS.reduce((n, s) => n + s.text.length, 0), countedFrom: "check-calendar-preview" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...extra,
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-calendar-preview");
  // Only this process's: the stub connection's tokens are encrypted with it.
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  const fx = await makeAccount("check-calendar-preview");
  const other = await makeAccount("check-calendar-preview-other");
  const t = fx.tag;
  const [memberRow] = await db.select({ email: schema.accountMembers.email }).from(schema.accountMembers).where(eqId(fx.memberId));
  const [memberB] = await db
    .insert(schema.accountMembers)
    .values({ accountId: fx.accountId, email: `b-${t}@clipwise.test`, role: "member", joinedAt: new Date() })
    .returning();
  const [memberC] = await db
    .insert(schema.accountMembers)
    .values({ accountId: fx.accountId, email: `c-${t}@clipwise.test`, role: "member", joinedAt: new Date() })
    .returning();

  const SIGN_IN = memberRow.email;
  const CAL = `cal-${t}@quorom.test`;
  const SHARED = `shared-${t}@leadiq.test`;
  const SELF = `alias-${t}@quorom.test`;
  const MIKE = `mike-${t}@example.test`;
  const GUEST = `guest-${t}@example.test`;
  const HIDDEN = `hidden-${t}@example.test`;
  const CROSS = `cross-${t}@example.test`;
  const NONAME = `noname-${t}@example.test`;
  const ATNAME = `atname-${t}@example.test`;
  const TITLE = `Check Event ${t}`;

  await db.insert(schema.calendarConnections).values({
    accountId: fx.accountId,
    memberId: fx.memberId,
    calendarEmail: CAL,
    accessToken: encrypt("check-access-token"),
    refreshToken: encrypt("check-refresh-token"),
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    searchedCalendarIds: [CAL, SHARED],
  });
  const setConnection = (set: { calendarEmail?: string; searchedCalendarIds?: string[] }) =>
    db.update(schema.calendarConnections).set(set).where(eqMember(fx.memberId));

  // People: Mike named and unattached (visible); Hidden only on member B's
  // private recording; Cross in the other account only; Noname with no name.
  await db.insert(schema.people).values([
    { accountId: fx.accountId, email: MIKE, name: "Mike Example" },
    { accountId: other.accountId, email: CROSS, name: "Cross Example" },
    { accountId: fx.accountId, email: NONAME, name: null },
  ]);
  const [hidden] = await db.insert(schema.people).values({ accountId: fx.accountId, email: HIDDEN, name: "Hidden Example" }).returning();
  const recB = await makeRecording({ accountId: fx.accountId, memberId: memberB.id, tag: t }, { segments: 1 });
  await db.insert(schema.attendees).values({ recordingId: recB, name: "Hidden Example", isHost: false, personId: hidden.id });

  // Google, stubbed. The event's attendees, as Google lists them.
  type Attendee = { email?: string; displayName?: string; self?: boolean };
  let attendees: Attendee[] = [];
  const resetAttendees = () => {
    attendees = [
      { email: SIGN_IN.toUpperCase() },
      { email: CAL },
      { email: SHARED },
      { email: SELF, self: true },
      { email: MIKE },
      { email: GUEST },
      { email: HIDDEN },
      { email: CROSS },
      { displayName: "Room 4" },
    ];
  };
  resetAttendees();
  // Which calendars answer 500: none, all, or those named. A calendar is named by
  // its id in the request path (/calendar/v3/calendars/<id>/events).
  let failingCalendars: Set<string> | "all" = new Set();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/")) throw new Error("check: the token endpoint is not expected (the token has not expired)");
    if (url.startsWith("https://www.googleapis.com/")) {
      const calendarId = decodeURIComponent(new URL(url).pathname.split("/")[4] ?? "");
      if (failingCalendars === "all" || failingCalendars.has(calendarId)) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ items: [{ id: `evt-${t}`, summary: TITLE, start: { dateTime: EVENT_START }, attendees }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;

  const ctxOf = (memberId: string, email: string) => ({ accountId: fx.accountId, memberId, role: "member", authUserId: "check", email, scope: ["clipwise:capture"] });
  let ctx = ctxOf(fx.memberId, SIGN_IN);
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = ctx as typeof req.access;
    next();
  });
  app.post("/captures/calendar-preview", calendarPreviewPost);
  app.post("/captures", capturesPost);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  type Preview = { matched: boolean; title: string | null; named: string[]; unnamed: string[] };
  const preview = async (startedAt = CAPTURE_START): Promise<{ status: number; p: Preview; raw: string }> => {
    const r = await post("/captures/calendar-preview", { startedAt });
    return { status: r.status, p: r.json as unknown as Preview, raw: JSON.stringify(r.json) };
  };
  const counts = async () =>
    JSON.stringify((await pool.query(`select (select count(*) from people where account_id = $1)::int as people, (select count(*) from invitees i join recordings r on r.id = i.recording_id where r.account_id = $1)::int as invitees`, [fx.accountId])).rows[0]);

  try {
    // o. the owner's own addresses.
    const before = await counts();
    const base0 = await preview();
    check("o: the preview matches the event (200, matched, its title)", base0.status === 200 && base0.p.matched === true && base0.p.title === TITLE, base0.raw);
    const ownerOut = [SIGN_IN.toLowerCase(), CAL, SHARED, SELF].filter((a) => base0.raw.toLowerCase().includes(a.toLowerCase()));
    check("o: none of the owner's addresses (sign-in, calendar_email, shared calendar, self) is in the reply", ownerOut.length === 0, ownerOut.join(","));

    ctx = ctxOf(fx.memberId, `someone-else-${t}@clipwise.test`);
    const ctlSignIn = await preview();
    ctx = ctxOf(fx.memberId, SIGN_IN);
    check("o: control: with another sign-in address, the first one appears", ctlSignIn.p.unnamed.includes(SIGN_IN.toLowerCase()), ctlSignIn.raw);

    await setConnection({ calendarEmail: `other-cal-${t}@quorom.test`, searchedCalendarIds: [`other-cal-${t}@quorom.test`, SHARED] });
    const ctlCal = await preview();
    check("o: control: with another calendar_email (and not searched), the connection's address appears", ctlCal.p.unnamed.includes(CAL), ctlCal.raw);
    await setConnection({ calendarEmail: CAL, searchedCalendarIds: [CAL] });
    const ctlShared = await preview();
    check("o: control: with the shared calendar not searched, its address appears", ctlShared.p.unnamed.includes(SHARED), ctlShared.raw);
    await setConnection({ calendarEmail: CAL, searchedCalendarIds: [CAL, SHARED] });

    attendees = attendees.map((a) => (a.email === SELF ? { email: SELF } : a));
    const ctlSelf = await preview();
    resetAttendees();
    check("o: control: not marked self, the alias appears", ctlSelf.p.unnamed.includes(SELF), ctlSelf.raw);

    // n. named by a person; never by address.
    check("n: Mike, a person in the account, is named", base0.p.named.includes("Mike Example"), base0.raw);
    check("n: and his address is nowhere in the reply", !base0.raw.includes(MIKE), base0.raw);
    check("n: control: the same scan finds an address the reply does carry (the guest's)", base0.raw.includes(GUEST), base0.raw);
    check("n: a guest with no person stays an address", base0.p.unnamed.includes(GUEST) && !base0.p.named.some((n) => n.includes("@")), base0.raw);

    // v. another member's private recording.
    check("v: Hidden, only on member B's private recording, is not named (an address)", !base0.p.named.includes("Hidden Example") && base0.p.unnamed.includes(HIDDEN), base0.raw);
    const recA = await makeRecording(fx, { segments: 1 });
    await db.insert(schema.attendees).values({ recordingId: recA, name: "Hidden Example", isHost: false, personId: hidden.id });
    const ctlHidden = await preview();
    check("v: control: once on a recording the caller owns, Hidden is named", ctlHidden.p.named.includes("Hidden Example") && !ctlHidden.p.unnamed.includes(HIDDEN), ctlHidden.raw);

    // x. another account.
    check("x: Cross, a person in another account only, is not named (an address)", !base0.p.named.includes("Cross Example") && base0.p.unnamed.includes(CROSS) && !base0.raw.includes("Cross Example"), base0.raw);
    await db.insert(schema.people).values({ accountId: fx.accountId, email: CROSS, name: "Cross Example" });
    const ctlCross = await preview();
    check("x: control: the same address in the caller's account is named", ctlCross.p.named.includes("Cross Example") && !ctlCross.p.unnamed.includes(CROSS), ctlCross.raw);

    // z. nothing to show, and a preview writes nothing.
    // The reason each matched=false logs: the route's line for the preview just made.
    const lastLine = () => serverLines[serverLines.length - 1] ?? "";
    const FAR = "2026-10-26T18:00:00.000Z";
    const far = await preview(FAR);
    check("z: no event within the threshold is matched=false (200)", far.status === 200 && far.p.matched === false && far.p.named.length === 0 && far.p.unnamed.length === 0, far.raw);
    check("z: control: with both searched calendars read, no event logs no_event_in_range", lastLine().endsWith("matched=no reason=no_event_in_range"), lastLine());
    ctx = ctxOf(memberC.id, memberC.email);
    const noConn = await preview();
    ctx = ctxOf(fx.memberId, SIGN_IN);
    check("z: a member with no calendar connected is matched=false (200)", noConn.status === 200 && noConn.p.matched === false, noConn.raw);

    failingCalendars = "all";
    const failing = await preview();
    failingCalendars = new Set();
    check("z: Google failing is matched=false (200)", failing.status === 200 && failing.p.matched === false, failing.raw);
    check("z: and logs calendar_unreadable failed=2/2, not no_event_in_range", lastLine().endsWith("matched=no reason=calendar_unreadable failed=2/2"), lastLine());

    // One of two failing, at a time the readable one has no event for: the one
    // that failed may have held it.
    failingCalendars = new Set([SHARED]);
    const partial = await preview(FAR);
    failingCalendars = new Set();
    check("z: one of two calendars failing, with no match, is matched=false (200)", partial.status === 200 && partial.p.matched === false, partial.raw);
    check("z: and logs calendar_unreadable failed=1/2", lastLine().endsWith("matched=no reason=calendar_unreadable failed=1/2"), lastLine());

    await setConnection({ searchedCalendarIds: [] });
    const noneSearched = await preview();
    await setConnection({ calendarEmail: CAL, searchedCalendarIds: [CAL, SHARED] });
    check("z: a connection searching no calendar is matched=false (200)", noneSearched.status === 200 && noneSearched.p.matched === false, noneSearched.raw);
    check("z: and logs no_searchable_calendars, not no_event_in_range", lastLine().endsWith("matched=no reason=no_searchable_calendars"), lastLine());
    const afterPreviews = await counts();
    // The one person this check inserted itself since (Cross, in x) and none other.
    const expected = JSON.stringify({ ...JSON.parse(before), people: JSON.parse(before).people + 1 });
    check("z: the previews wrote no people and no invitee rows", afterPreviews === expected, `${before} -> ${afterPreviews}`);

    // c. a capture sent with inviteeNames.
    const identity = {
      identity_version: 2,
      answered_at: "2026-10-26T15:31:00.000Z",
      self: { name: "Check Host", source: "recorder_identity_prompt" },
      guests: [{ name: "Guest Example" }, { name: "Mike Example" }],
      scope: "work",
    };
    check("c: precondition: the capture's identity answer carries no @", !JSON.stringify(identity).includes("@"));
    const inviteeNames = [
      { email: GUEST.toUpperCase(), name: " Guest Example " },
      { email: NONAME, name: "Nora Example" },
      { email: MIKE, name: "Michael Other" },
      { email: SHARED, name: "Owner Shared" },
      { email: CAL, name: "Owner Calendar" },
      { email: SIGN_IN, name: "Owner Sign-in" },
      { email: ATNAME, name: `typed-${t}@address.test` },
    ];
    const pc = payload({ identity, inviteeNames });
    const rc = await post("/captures", pc);
    const rec = String(rc.json.recordingId);
    check("c: the capture is stored (201)", rc.status === 201, `${rc.status} ${JSON.stringify(rc.json)}`);
    const person = async (email: string) => (await pool.query(`select id, email, name from people where account_id = $1 and lower(email) = $2`, [fx.accountId, email.toLowerCase()])).rows;
    const guestRows = await person(GUEST);
    check("c: the guest's person is created, by address (normalized), with the typed name (trimmed)", guestRows.length === 1 && guestRows[0].email === GUEST && guestRows[0].name === "Guest Example", JSON.stringify(guestRows));
    const att = async () => (await pool.query(`select name, person_id from attendees where recording_id = $1 and not is_host order by name`, [rec])).rows as Array<{ name: string; person_id: string | null }>;
    const atts = await att();
    check("c: the guest attendee row named Guest Example is linked to that person", atts.find((a) => a.name === "Guest Example")?.person_id === guestRows[0]?.id, JSON.stringify(atts));
    // Changed in SAA-260 step 2: the pair naming Mike's address "Michael Other"
    // still links nothing (his person keeps its name), but the guest row "Mike
    // Example" is then linked by the same-name rule: exactly one person the
    // caller may see has that name (Mike, unattached).
    const mikeId = (await person(MIKE))[0]?.id;
    check("c: the Mike Example attendee is linked by name to Mike (same-name rule), not through the pair that named his address as someone else", !!mikeId && atts.find((a) => a.name === "Mike Example")?.person_id === mikeId, JSON.stringify(atts));
    check("c: a person with no name gets the typed one", (await person(NONAME))[0]?.name === "Nora Example", JSON.stringify(await person(NONAME)));
    check("c: a person with a name keeps it", (await person(MIKE))[0]?.name === "Mike Example", JSON.stringify(await person(MIKE)));
    const ownerRows = [...(await person(SHARED)), ...(await person(CAL)), ...(await person(SIGN_IN))];
    check("c: the owner's addresses are refused: no person for any of them", ownerRows.length === 0, JSON.stringify(ownerRows));
    check(
      "c: a name with an @ is refused: no person for its address (control: the guest's pair, the same address shape with a plain name, created one above)",
      (await person(ATNAME)).length === 0 && guestRows.length === 1,
      JSON.stringify(await person(ATNAME)),
    );

    // The match job ran before the repeat: an invitee row for the guest, unlinked.
    await db.insert(schema.invitees).values({ recordingId: rec, email: GUEST, name: null, responseStatus: "accepted" });
    const beforeRepeat = await counts();
    const rr = await post("/captures", pc);
    check("c: the same capture again is 200 and creates no person", rr.status === 200 && (await counts()) === beforeRepeat, `${rr.status} ${beforeRepeat} -> ${await counts()}`);
    const inv = (await pool.query(`select person_id from invitees where recording_id = $1 and email = $2`, [rec, GUEST])).rows[0];
    check("c: on the repeat, the guest's invitee row is linked to the person", inv?.person_id === guestRows[0]?.id, JSON.stringify(inv));
    check("c: and names are as they were", (await person(GUEST))[0]?.name === "Guest Example" && (await person(MIKE))[0]?.name === "Mike Example");

    const later = await preview();
    check("c: a later preview names the guest, and no longer by address", later.p.named.includes("Guest Example") && !later.p.unnamed.includes(GUEST) && !later.raw.includes(GUEST), later.raw);

    check("c: exactly one person carries the guest's typed name (SAA-260 step 2: no name-only one beside it)", (await pool.query(`select count(*)::int as n from people where account_id = $1 and lower(btrim(name)) = 'guest example'`, [fx.accountId])).rows[0].n === 1);

    // d. the same-name rule in invitee-names (SAA-260 step 2): no person has
    // the address, so the people with no address and the typed name decide.
    const namedCount = async (name: string) =>
      (await pool.query(`select count(*)::int as n from people where account_id = $1 and lower(btrim(name)) = lower($2)`, [fx.accountId, name])).rows[0].n as number;
    const ADA = `ada-${t}@example.test`;
    const BO = `bo-${t}@example.test`;
    const [ada] = await db.insert(schema.people).values({ accountId: fx.accountId, email: null, name: "Ada Adopt" }).returning();
    const bos = await db.insert(schema.people).values([{ accountId: fx.accountId, email: null, name: "Bo Twin" }, { accountId: fx.accountId, email: null, name: "Bo Twin" }]).returning();
    const dIdentity = { ...identity, answered_at: "2026-10-26T15:33:00.000Z", guests: [{ name: "Ada Adopt" }, { name: "Bo Twin" }] };
    const rd = await post("/captures", payload({ identity: dIdentity, inviteeNames: [{ email: ADA, name: "Ada Adopt" }, { email: BO, name: "Bo Twin" }] }));
    const recD = String(rd.json.recordingId);
    check("d: the capture is stored (201)", rd.status === 201, `${rd.status} ${JSON.stringify(rd.json)}`);
    const adaRows = await person(ADA);
    check("d: one person with no address has the name: it gets the address and is reused", adaRows.length === 1 && adaRows[0].id === ada.id, JSON.stringify(adaRows));
    check("d: and no second Ada Adopt is created", (await namedCount("Ada Adopt")) === 1, String(await namedCount("Ada Adopt")));
    const boRows = await person(BO);
    check("d: two people with no address have the name: a new person is created with the address, as before", boRows.length === 1 && !bos.some((b) => b.id === boRows[0].id), JSON.stringify(boRows));
    check("d: and the two keep no address", (await pool.query(`select count(*)::int as n from people where id = any($1) and email is null`, [bos.map((b) => b.id)])).rows[0].n === 2);
    const dAtts = (await pool.query(`select name, person_id from attendees where recording_id = $1 and not is_host`, [recD])).rows as Array<{ name: string; person_id: string | null }>;
    check("d: each guest row is linked to the person with its address", dAtts.find((a) => a.name === "Ada Adopt")?.person_id === ada.id && dAtts.find((a) => a.name === "Bo Twin")?.person_id === boRows[0]?.id, JSON.stringify(dAtts));

    // m. the recording's whole metadata.
    const metadata = (await pool.query(`select metadata from recordings where id = $1`, [rec])).rows[0]?.metadata;
    const scan = (value: unknown) => {
      const s = JSON.stringify(value);
      return { inviteeNames: s.includes("inviteeNames"), at: s.includes("@") };
    };
    const m = scan(metadata);
    check("m: the recording's metadata holds no \"inviteeNames\" and no @", metadata && !m.inviteeNames && !m.at, JSON.stringify(m));
    const planted = scan({ ...metadata, capture: { ...metadata?.capture, planted: { inviteeNames: [{ email: "planted@example.test" }] } } });
    check("m: control: the same scan finds both planted in a copy", planted.inviteeNames && planted.at, JSON.stringify(planted));

    // a. a guest name with an @ in the identity answer.
    const atIdentity = { ...identity, answered_at: "2026-10-26T15:32:00.000Z", guests: [{ name: `typed-${t}@address.test` }, { name: "Real Name" }] };
    check("a: control: the answer sent does carry an @", JSON.stringify(atIdentity).includes("@"));
    const ra = await post("/captures", payload({ identity: atIdentity }));
    const aAtts = (await pool.query(`select name from attendees where recording_id = $1`, [String(ra.json.recordingId)])).rows.map((r) => String(r.name));
    check("a: the capture is stored, and no attendee name carries an @ (Real Name and the host are there)", ra.status === 201 && !aAtts.some((n) => n.includes("@")) && aAtts.includes("Real Name") && aAtts.includes("Check Host"), `${ra.status} ${JSON.stringify(aAtts)}`);

    // l. the route's log lines.
    const leaks = (lines: string[]) => {
      const text = lines.join("\n");
      return { at: text.includes("@"), title: text.includes(TITLE), names: ["Mike Example", "Guest Example", "Hidden Example", "Cross Example", "Nora Example"].some((n) => text.includes(n)) };
    };
    const haveBoth = serverLines.some((l) => l.startsWith("calendar-preview: ")) && serverLines.some((l) => l.startsWith("invitee-names: "));
    check(`l: the route's lines were captured (${serverLines.length}, both kinds)`, haveBoth, serverLines.join(" | "));
    const peopleLines = serverLines.filter((l) => l.startsWith("attendee-people: ")).length;
    check(`l: attendee-people lines were captured too (${peopleLines}; SAA-260 step 2)`, peopleLines > 0, serverLines.join(" | "));
    const l = leaks(serverLines);
    check("l: no @, no title, no name in them", !l.at && !l.title && !l.names, JSON.stringify(l));
    const lc = leaks([...serverLines, `planted ${MIKE}`, `planted ${TITLE}`, "planted Guest Example"]);
    check("l: control: the same scan finds each planted in a copy", lc.at && lc.title && lc.names, JSON.stringify(lc));
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    await dropAccount(fx);
    await dropAccount(other);
    await endPool();
  }
  realLog(failures === 0 ? "\ncheck-calendar-preview: all passed" : `\ncheck-calendar-preview: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

const eqId = (id: string) => eq(schema.accountMembers.id, id);
const eqMember = (id: string) => eq(schema.calendarConnections.memberId, id);

main().catch((err) => {
  realLog(`check-calendar-preview: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
