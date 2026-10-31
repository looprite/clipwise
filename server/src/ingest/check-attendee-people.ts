// Check for attendees stored by person id (SAA-260 step 2): POST /captures links
// each guest attendee row to a person in the same transaction, by the answer's
// personId, by an invitee's address, or by the same-name rule. Real route and a
// real (scratch) database; the request's sign-in is a middleware that sets the
// access context the capture-token guard would (as check-identity-correction
// does), with a header choosing member A or B. Names are made up.
//
//   c   a guest no visible person has the name of gets a new person: email
//       null, people.name tidied (normalizeName), attendees.name as sent
//   r   the same name on a later capture reuses that person; no second one
//   t   two visible people with the name: the guest stays unlinked and nothing
//       is created. Control: with exactly one, it is reused
//   v   a person only on member B's private call is not matched for member A;
//       A gets a person of their own. Control: once B's call is shared, A's
//       guest reuses B's person
//   y   a lost-reply retry of a capture: 200, nothing created, rows unchanged
//   n   a stored decomposed name matches a composed typed one (NFC), with a
//       guard that the two raw strings differ
//   i   inviteeNames and the typed guest in one capture: one person, the one
//       with the address, and no name-only person with that name
//   p   guests[].personId the caller may see is used, even where the name alone
//       would leave the row unlinked. One from another account, or on another
//       member's private call, is ignored and the name resolved instead
//   w   a group call: a voice named after a linked guest carries that guest's
//       person (voice-names.ts copies it)
//   k   two captures sent at once naming the same new person: one person
//   h   the host line: the host row is never linked; a guest named as the
//       member's display name stays unlinked even though a person with that
//       name exists (control: another guest links); and, on a correction, a
//       guest named as the answer's self name stays unlinked too
//   f   the fingerprint: a names-only recording made before step 2 keeps its
//       rows, its stored extraction fingerprint and its fingerprint hash, and
//       gets no re_extract, while later captures name the same guest. A linked
//       recording's fingerprint hash is the same with its person ids nulled
//
//   scripts/scratch-db.sh run check-attendee-people

import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { runExtraction, speakerFingerprintHash } from "../extract/extract.js";
import { makeStubModel } from "../extract/stub-model.js";
import { errorHandler } from "../lib/http.js";
import { capturesPost } from "../routes/captures.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

type Seg = { track: "me" | "them"; startMs: number; endMs: number; text: string; voiceIndex?: number };
const seg = (track: "me" | "them", startSec: number, endSec: number, text: string, voiceIndex?: number): Seg =>
  ({ track, startMs: startSec * 1000, endMs: endSec * 1000, text, ...(voiceIndex ? { voiceIndex } : {}) });
const ONE_TO_ONE: Seg[] = [seg("me", 0, 1.5, "opening"), seg("them", 2, 4, "first"), seg("me", 5, 7, "second"), seg("them", 8, 10, "third")];
const GROUP: Seg[] = [
  seg("me", 0, 1.5, "opening"),
  seg("them", 2, 4, "first", 1),
  seg("them", 5, 7, "second", 2),
  seg("them", 8, 10, "third", 1),
];
const VOICES = [
  { voiceIndex: 1, totalSeconds: 4 },
  { voiceIndex: 2, totalSeconds: 2 },
];

function payload(segments: Seg[], extra: Record<string, unknown> = {}): Record<string, unknown> & { captureId: string } {
  const id = randomUUID().toUpperCase();
  const report = (track: "tap" | "mic", label: "them" | "me") => ({ track, label, band: "live", verdict: "live", permission: "granted", rms: 0.02, peak: 0.4, nonzero_fraction: 0.9, duration_s: 10, gaps: [], note: "check" });
  return {
    captureId: id,
    startedAt: "2026-10-31T16:31:00.000Z",
    stem: `check-attendee-people-${id.slice(0, 8).toLowerCase()}`,
    engine: "parakeet",
    model: "check-model",
    language: "en",
    segments,
    sourceFidelity: { declaredTurnCount: segments.length, declaredBodyChars: segments.reduce((n, x) => n + x.text.length, 0), countedFrom: "check-attendee-people" },
    classification: { verdict: "both_present", concern: false, reason: "check", excludedLabels: [] as string[], tracks: { tap: report("tap", "them"), mic: report("mic", "me") } },
    capture: { permissions: { tap: "granted", mic: "granted" }, triggerApp: null },
    ...extra,
  };
}

type Guest = string | { name: string; personId: string };
const answer = (guests: Guest[], self = "Check Host") => ({
  identity_version: 2,
  answered_at: `2026-10-31T17:00:00.${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}Z`,
  self: { name: self, source: "recorder_identity_prompt" },
  guests: guests.map((g) => (typeof g === "string" ? { name: g } : g)),
  scope: "work",
});

async function main(): Promise<void> {
  await refuseUnlessScratch("check-attendee-people");
  process.env.ANTHROPIC_API_KEY = "stub-key";
  const fx = await makeAccount("check-attendee-people");
  const other = await makeAccount("check-attendee-people-other");
  const [memberB] = await db
    .insert(schema.accountMembers)
    .values({ accountId: fx.accountId, email: `check-attendee-people-b-${fx.tag}@clipwise.test`, role: "member", joinedAt: new Date() })
    .returning();
  // The member's account name, which the host line must never link as a guest.
  await db.update(schema.accountMembers).set({ displayName: "Jon Example" }).where(eq(schema.accountMembers.id, fx.memberId));
  const ctxFor = (memberId: string, who: string) => ({ accountId: fx.accountId, memberId, role: "member", authUserId: who, email: `${who}@clipwise.test`, scope: ["clipwise:capture"] });
  const ctxA = ctxFor(fx.memberId, "check-a");
  const ctxB = ctxFor(memberB.id, "check-b");

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, _res, next) => {
    req.access = (req.header("x-member") === "b" ? ctxB : ctxA) as typeof req.access;
    next();
  });
  app.post("/captures", capturesPost);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, member: "a" | "b" = "a"): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}/captures`, { method: "POST", headers: { "content-type": "application/json", "x-member": member }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const guestRow = async (rec: string, name: string): Promise<{ name: string; person_id: string | null } | undefined> =>
    (await pool.query(`select name, person_id from attendees where recording_id = $1 and not is_host and name = $2`, [rec, name])).rows[0];
  const hostRow = async (rec: string): Promise<{ person_id: string | null } | undefined> =>
    (await pool.query(`select person_id from attendees where recording_id = $1 and is_host`, [rec])).rows[0];
  const person = async (id: string | null | undefined): Promise<{ name: string | null; email: string | null } | undefined> =>
    id ? (await pool.query(`select name, email from people where id = $1`, [id])).rows[0] : undefined;
  // People in the account whose name compares equal, the way the rule compares.
  const peopleNamed = async (name: string): Promise<number> =>
    (await pool.query(
      `select count(*)::int as n from people where account_id = $1 and lower(regexp_replace(btrim(normalize(name, NFC)), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(normalize($2, NFC)), '\\s+', ' ', 'g'))`,
      [fx.accountId, name],
    )).rows[0].n;
  const peopleCount = async (): Promise<number> =>
    (await pool.query(`select count(*)::int as n from people where account_id = $1`, [fx.accountId])).rows[0].n;
  // An unattached person (on no recording), visible to every member.
  const plantPerson = async (accountId: string, name: string, email: string | null = null): Promise<string> =>
    (await pool.query(`insert into people (account_id, name, email) values ($1, $2, $3) returning id`, [accountId, name, email])).rows[0].id;
  const capture = async (guests: Guest[], member: "a" | "b" = "a", extra: Record<string, unknown> = {}): Promise<string> => {
    const r = await post(payload(ONE_TO_ONE, { identity: answer(guests), ...extra }), member);
    if (r.status !== 201) throw new Error(`capture not stored: ${r.status} ${JSON.stringify(r.json)}`);
    return String(r.json.recordingId);
  };

  try {
    // f (before). A names-only recording as main holds them, extracted once.
    const rec0 = await makeRecording(fx, { segments: 4, attendeeName: "Ann Example" });
    await runExtraction(rec0, { client: makeStubModel({ segmentCount: 4, phrase: "check-attendee-people" }).client });
    const state0 = async () => JSON.stringify({
      attendees: (await pool.query(`select name, is_host, person_id from attendees where recording_id = $1 order by name`, [rec0])).rows,
      fp: (await pool.query(`select metadata->>'extraction_speaker_fingerprint' as fp from recordings where id = $1`, [rec0])).rows[0].fp,
      jobs: (await pool.query(`select count(*)::int as n from jobs where recording_id = $1 and kind = 're_extract'`, [rec0])).rows[0].n,
    });
    const before0 = await state0();
    const hash0 = await speakerFingerprintHash(rec0);
    check("f: control: the old recording has a stored extraction fingerprint", JSON.parse(before0).fp !== null, before0);

    // c. a new name creates a person.
    const recC = await capture(["Ann   Example"]);
    const rowC = await guestRow(recC, "Ann   Example");
    const pC = await person(rowC?.person_id);
    check("c: the guest row is linked to a person", !!rowC?.person_id, JSON.stringify(rowC));
    check("c: the person has no address and the tidied name", pC?.email === null && pC?.name === "Ann Example", JSON.stringify(pC));
    check("c: attendees.name is kept as sent", rowC?.name === "Ann   Example", JSON.stringify(rowC));
    check("c: the host row has no person", (await hostRow(recC))?.person_id === null, JSON.stringify(await hostRow(recC)));

    // r. the same name again reuses it.
    const recR = await capture(["ann example"]);
    const rowR = await guestRow(recR, "ann example");
    check("r: a later capture's guest is linked to the same person", rowR?.person_id === rowC?.person_id, `${rowR?.person_id} vs ${rowC?.person_id}`);
    check("r: there is still one person with that name", (await peopleNamed("Ann Example")) === 1, String(await peopleNamed("Ann Example")));

    // t. two visible people with the name: unlinked, nothing created.
    await plantPerson(fx.accountId, "Bea Example");
    await plantPerson(fx.accountId, "Bea Example");
    const recT = await capture(["Bea Example"]);
    check("t: with two people named Bea Example, the guest stays unlinked", (await guestRow(recT, "Bea Example"))?.person_id === null, JSON.stringify(await guestRow(recT, "Bea Example")));
    check("t: and no third is created", (await peopleNamed("Bea Example")) === 2, String(await peopleNamed("Bea Example")));
    const cal = await plantPerson(fx.accountId, "Cal Example");
    const recT1 = await capture(["Cal Example"]);
    check("t: control: with exactly one, it is reused", (await guestRow(recT1, "Cal Example"))?.person_id === cal, JSON.stringify(await guestRow(recT1, "Cal Example")));

    // v. a person only on B's private call is invisible to A.
    const recVb = await capture(["Dan Example"], "b");
    const danB = (await guestRow(recVb, "Dan Example"))?.person_id ?? null;
    const recVa = await capture(["Dan Example"], "a");
    const danA = (await guestRow(recVa, "Dan Example"))?.person_id ?? null;
    check("v: B's guest got a person", !!danB, String(danB));
    check("v: A's guest is not linked to the person on B's private call; A gets one of their own", !!danA && danA !== danB, `${danA} vs ${danB}`);
    const recVb2 = await capture(["Eve Example"], "b");
    const eveB = (await guestRow(recVb2, "Eve Example"))?.person_id ?? null;
    await pool.query(`update recordings set visibility = 'shared' where id = $1`, [recVb2]);
    const recVa2 = await capture(["Eve Example"], "a");
    check("v: control: once B's call is shared, A's guest reuses B's person", !!eveB && (await guestRow(recVa2, "Eve Example"))?.person_id === eveB, `${(await guestRow(recVa2, "Eve Example"))?.person_id} vs ${eveB}`);

    // y. a lost-reply retry creates nothing.
    const py = payload(ONE_TO_ONE, { identity: answer(["Fin Example"]) });
    const ry0 = await post(py);
    const recY = String(ry0.json.recordingId);
    const rowsY = async () => JSON.stringify((await pool.query(`select name, is_host, person_id from attendees where recording_id = $1 order by is_host desc, name`, [recY])).rows);
    const beforeY = { rows: await rowsY(), people: await peopleCount() };
    const ry = await post(py);
    check("y: the retry is 200, not created again", ry.status === 200 && ry.json.created === false, `${ry.status} ${JSON.stringify(ry.json)}`);
    check("y: and creates no person and changes no row", (await peopleCount()) === beforeY.people && (await rowsY()) === beforeY.rows, `${await peopleCount()} vs ${beforeY.people}`);
    check("y: control: the first send did link Fin Example", !!(await guestRow(recY, "Fin Example"))?.person_id);

    // n. NFC: a decomposed stored name and a composed typed one are one name.
    const decomposed: string = "Jose\u0301 Nfc", composed: string = "Jos\u00e9 Nfc";
    check("n: guard: the decomposed and composed raw strings differ", decomposed !== composed, `${decomposed.length} / ${composed.length}`);
    const jose = await plantPerson(fx.accountId, decomposed);
    const recN = await capture([composed]);
    check("n: the composed guest reuses the person stored decomposed", (await guestRow(recN, composed))?.person_id === jose, JSON.stringify(await guestRow(recN, composed)));

    // i. inviteeNames plus the typed guest: one person, with the address.
    const recI = await capture(["Gil Example"], "a", { inviteeNames: [{ email: "gil@example.test", name: "Gil Example" }] });
    const gil = (await guestRow(recI, "Gil Example"))?.person_id ?? null;
    check("i: the guest is linked to the person with the address", (await person(gil))?.email === "gil@example.test", JSON.stringify(await person(gil)));
    check("i: and there is one person named Gil Example, not a name-only one beside it", (await peopleNamed("Gil Example")) === 1, String(await peopleNamed("Gil Example")));

    // p. guests[].personId.
    const hal1 = await plantPerson(fx.accountId, "Hal Example");
    await plantPerson(fx.accountId, "Hal Example");
    const recP = await capture([{ name: "Hal Example", personId: hal1 }]);
    check("p: a visible personId is used, where the name alone (two Hals) would leave it unlinked", (await guestRow(recP, "Hal Example"))?.person_id === hal1, JSON.stringify(await guestRow(recP, "Hal Example")));
    const foreign = await plantPerson(other.accountId, "Ida Example");
    const recP2 = await capture([{ name: "Ida Example", personId: foreign }]);
    const ida = (await guestRow(recP2, "Ida Example"))?.person_id ?? null;
    check("p: another account's personId is ignored, and the name resolved in this account", !!ida && ida !== foreign && (await peopleNamed("Ida Example")) === 1, `${ida} vs ${foreign}`);
    const recP3 = await capture(["Jay Example"], "b");
    const jayB = (await guestRow(recP3, "Jay Example"))?.person_id ?? null;
    const recP4 = await capture([{ name: "Jay Example", personId: jayB as string }], "a");
    const jayA = (await guestRow(recP4, "Jay Example"))?.person_id ?? null;
    check("p: a personId on another member's private call is ignored; A gets one of their own", !!jayB && !!jayA && jayA !== jayB, `${jayA} vs ${jayB}`);

    // w. a voice named after a linked guest carries the guest's person.
    const pw = payload(GROUP, {
      voices: VOICES,
      identity: answer(["Kim Example", "Lee Example"]),
      voiceNames: { answered_at: "2026-10-31T17:30:00.000Z", voices: [{ voiceIndex: 1, name: "Kim Example" }, { voiceIndex: 2, name: null }] },
    });
    const rw = await post(pw);
    const recW = String(rw.json.recordingId);
    const kim = (await guestRow(recW, "Kim Example"))?.person_id ?? null;
    const voice = async (label: string) => (await pool.query(`select display_name, person_id from speakers where recording_id = $1 and label = $2`, [recW, label])).rows[0];
    check("w: Voice 1, named Kim Example, carries Kim's person", !!kim && (await voice("Voice 1"))?.person_id === kim, `${JSON.stringify(await voice("Voice 1"))} vs ${kim}`);
    check("w: control: Voice 2, not named, has no person", (await voice("Voice 2"))?.person_id === null, JSON.stringify(await voice("Voice 2")));

    // k. two captures at once naming the same new person.
    const [k1, k2] = await Promise.all([post(payload(ONE_TO_ONE, { identity: answer(["Kit Example"]) })), post(payload(ONE_TO_ONE, { identity: answer(["Kit Example"]) }))]);
    const kit1 = (await guestRow(String(k1.json.recordingId), "Kit Example"))?.person_id ?? null;
    const kit2 = (await guestRow(String(k2.json.recordingId), "Kit Example"))?.person_id ?? null;
    check("k: both stored", k1.status === 201 && k2.status === 201, `${k1.status} ${k2.status}`);
    check("k: one person named Kit Example, and both guests point at it", (await peopleNamed("Kit Example")) === 1 && !!kit1 && kit1 === kit2, `${await peopleNamed("Kit Example")} people; ${kit1} / ${kit2}`);

    // h. the host line. On a first send a guest named as the self name is
    // dropped as the host's duplicate (applyIdentity), so that half is checked
    // on a correction, which keeps it as a guest row.
    await plantPerson(fx.accountId, "Jon Example", `jon-${fx.tag}@example.test`);
    await plantPerson(fx.accountId, "Check Host");
    const h1 = answer(["Jon Example", "Lou Example"]);
    const ph = payload(ONE_TO_ONE, { identity: h1 });
    const rh = await post(ph);
    const recH = String(rh.json.recordingId);
    check("h: the host row has no person", (await hostRow(recH))?.person_id === null, JSON.stringify(await hostRow(recH)));
    check("h: a guest named as the member's display name stays unlinked (a person with that name exists)", !!(await guestRow(recH, "Jon Example")) && (await guestRow(recH, "Jon Example"))?.person_id === null, JSON.stringify(await guestRow(recH, "Jon Example")));
    check("h: control: Lou Example links", !!(await guestRow(recH, "Lou Example"))?.person_id);
    const rh2 = await post({ ...ph, identity: { ...answer(["Check Host", "Lou Example"]), corrects: h1.answered_at } });
    check("h: the correction naming the self name as a guest is applied", rh2.status === 200 && rh2.json.identityApplied === true, `${rh2.status} ${JSON.stringify(rh2.json)}`);
    check("h: a guest named as the answer's self name stays unlinked (a person with that name exists)", !!(await guestRow(recH, "Check Host")) && (await guestRow(recH, "Check Host"))?.person_id === null, JSON.stringify(await guestRow(recH, "Check Host")));
    check("h: and the host row still has no person", (await hostRow(recH))?.person_id === null, JSON.stringify(await hostRow(recH)));

    // f (after). The old recording is as it was; nothing is queued for it.
    const after0 = await state0();
    check("f: the old recording's attendees, stored fingerprint and re_extract count are unchanged", after0 === before0, `${before0}\n     ${after0}`);
    check("f: its fingerprint hash is unchanged", (await speakerFingerprintHash(rec0)) === hash0);
    check("f: control: its Ann Example row is still unlinked, though Ann Example now has a person", JSON.parse(after0).attendees.some((a: { name: string; person_id: string | null }) => a.name === "Ann Example" && a.person_id === null) && (await peopleNamed("Ann Example")) === 1, after0);
    const linkedHash = await speakerFingerprintHash(recC);
    let nulledHash = "";
    await db
      .transaction(async (tx) => {
        await tx.update(schema.attendees).set({ personId: null }).where(eq(schema.attendees.recordingId, recC));
        nulledHash = await speakerFingerprintHash(recC, tx);
        throw new Error("rollback");
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== "rollback") throw err;
      });
    check("f: a linked recording's fingerprint hash is the same with its person ids nulled", nulledHash !== "" && nulledHash === linkedHash, `${linkedHash} vs ${nulledHash}`);
    check("f: control: the rollback left the link in place", !!(await guestRow(recC, "Ann   Example"))?.person_id);
  } finally {
    server.close();
    await dropAccount(fx);
    await dropAccount(other);
    await endPool();
  }
  console.log(failures === 0 ? "\ncheck-attendee-people: all passed" : `\ncheck-attendee-people: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`check-attendee-people: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
