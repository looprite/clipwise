// DB-less check of the calendar preview's rules (SAA-221): which addresses are
// the owner's own (ingest/invitee-names.ts ownerAddresses), which of an event's
// attendees are invitees (routes/calendar-preview.ts inviteeAddresses), and how
// people rows split them into names and addresses (splitByPeople). Every
// exclusion has its control: the same address, not an owner address, appears.
//
// No database: DATABASE_URL is set to a loopback port nothing listens on before
// anything is imported (db/index.ts requires one at import and connects only on
// a query), so a query made by mistake fails instead of reaching a database.
//
//   DOTENV_CONFIG_PATH=/dev/null npx --no-install tsx src/routes/check-calendar-preview-rules.ts

process.env.DATABASE_URL = "postgres://check:check@127.0.0.1:1/none";

import type { CalendarEvent } from "../lib/google-calendar.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}
const has = (list: string[], v: string) => list.includes(v);

async function main(): Promise<void> {
  const { ownerAddresses } = await import("../ingest/invitee-names.js");
  const { inviteeAddresses, splitByPeople } = await import("./calendar-preview.js");

  const event = (attendees: CalendarEvent["attendees"]): CalendarEvent => ({ id: "evt", start: { dateTime: "2026-09-29T19:30:00Z" }, attendees });
  const MIKE = "mike@example.test";

  // --- ownerAddresses -------------------------------------------------------
  const conn = {
    calendarEmail: "JD@quorom.io",
    searchedCalendarIds: ["jd@quorom.io", "jd@leadiq.com", "c_team123@group.calendar.google.com", "en.usa#holiday@group.v.calendar.google.com", "no-at-sign-id"],
  };
  const owner = ownerAddresses(" Jon@Looprite.ai ", conn);
  check("owner: the sign-in address, normalized", owner.has("jon@looprite.ai"), [...owner].join(","));
  check("owner: the connection's calendar_email, normalized", owner.has("jd@quorom.io"), [...owner].join(","));
  check("owner: a searched calendar's address (jd@leadiq.com, shared into the grant)", owner.has("jd@leadiq.com"), [...owner].join(","));
  check("owner: a searched calendar id with no @ is not an address", !owner.has("no-at-sign-id"), [...owner].join(","));
  const ownerNoConn = ownerAddresses("jon@looprite.ai", null);
  check("owner: with no connection, the sign-in address only", ownerNoConn.size === 1 && ownerNoConn.has("jon@looprite.ai"), [...ownerNoConn].join(","));

  // --- each exclusion, with its control ---------------------------------------
  // self: Google marks the caller; the address is in no owner set.
  const selfEv = event([{ email: "alias@quorom.io", self: true }, { email: MIKE }]);
  const selfOut = inviteeAddresses(selfEv, new Set());
  check("self: an attendee marked self is left out", !has(selfOut, "alias@quorom.io") && has(selfOut, MIKE), selfOut.join(","));
  const selfCtl = inviteeAddresses(event([{ email: "alias@quorom.io" }, { email: MIKE }]), new Set());
  check("self: control: the same address, not marked self, appears", has(selfCtl, "alias@quorom.io"), selfCtl.join(","));

  // The sign-in address.
  const signIn = event([{ email: "Jon@Looprite.ai" }, { email: MIKE }]);
  const signInOut = inviteeAddresses(signIn, ownerAddresses("jon@looprite.ai", null));
  check("sign-in: the member's own address is left out (case-insensitive)", !has(signInOut, "jon@looprite.ai") && has(signInOut, MIKE), signInOut.join(","));
  const signInCtl = inviteeAddresses(signIn, ownerAddresses("someone-else@looprite.ai", null));
  check("sign-in: control: for another member, the same address appears", has(signInCtl, "jon@looprite.ai"), signInCtl.join(","));

  // calendar_email, differing from the sign-in address.
  const calEv = event([{ email: "jd@quorom.io" }, { email: MIKE }]);
  const calOut = inviteeAddresses(calEv, ownerAddresses("jon@looprite.ai", { calendarEmail: "jd@quorom.io", searchedCalendarIds: [] }));
  check("calendar_email: the connection's address is left out", !has(calOut, "jd@quorom.io") && has(calOut, MIKE), calOut.join(","));
  const calCtl = inviteeAddresses(calEv, ownerAddresses("jon@looprite.ai", { calendarEmail: "other@quorom.io", searchedCalendarIds: [] }));
  check("calendar_email: control: with another calendar_email, the same address appears", has(calCtl, "jd@quorom.io"), calCtl.join(","));

  // A searched calendar shared into the grant: jd@leadiq.com.
  const sharedEv = event([{ email: "jd@leadiq.com" }, { email: MIKE }]);
  const sharedOut = inviteeAddresses(sharedEv, ownerAddresses("jon@looprite.ai", { calendarEmail: "jd@quorom.io", searchedCalendarIds: ["jd@quorom.io", "jd@leadiq.com"] }));
  check("shared calendar: jd@leadiq.com, a searched calendar, is left out", !has(sharedOut, "jd@leadiq.com") && has(sharedOut, MIKE), sharedOut.join(","));
  const sharedCtl = inviteeAddresses(sharedEv, ownerAddresses("jon@looprite.ai", { calendarEmail: "jd@quorom.io", searchedCalendarIds: ["jd@quorom.io"] }));
  check("shared calendar: control: not searched, the same address appears", has(sharedCtl, "jd@leadiq.com"), sharedCtl.join(","));

  // --- the 09-29 "Mike / Jon" shape, all at once -------------------------------
  const real = event([
    { email: "jd@quorom.io", self: true },
    { email: "JD@LeadIQ.com" },
    { email: "Mike@Example.test" },
    { email: "mike@example.test" },
    { displayName: "Room 4" },
    { email: "guest@example.test" },
  ]);
  const realOut = inviteeAddresses(real, owner);
  check("the call's shape: only the other invitees, normalized, once each, a room with no address skipped", JSON.stringify(realOut) === JSON.stringify([MIKE, "guest@example.test"]), realOut.join(","));

  // --- splitByPeople ----------------------------------------------------------
  const split = splitByPeople(
    [MIKE, "guest@example.test", "noname@example.test", "atname@example.test", "mike2@example.test"],
    [
      { email: "Mike@Example.test", name: " Mike Example " },
      { email: "noname@example.test", name: null },
      { email: "atname@example.test", name: "x@example.test" },
      { email: "mike2@example.test", name: "mike example" },
    ],
  );
  check("split: a person with a name names its address (row's email case ignored, name trimmed)", JSON.stringify(split.named) === JSON.stringify(["Mike Example"]), JSON.stringify(split));
  check("split: two addresses with the same name give the name once", split.named.length === 1, JSON.stringify(split));
  check("split: no person, a person with no name, and a name with an @ stay addresses", JSON.stringify(split.unnamed) === JSON.stringify(["guest@example.test", "noname@example.test", "atname@example.test"]), JSON.stringify(split));
  const atIn = (list: string[]) => list.some((v) => v.includes("@"));
  check("split: no name in `named` carries an @", !atIn(split.named), JSON.stringify(split.named));
  check("split: control: the same scan finds an @ planted in a copy of `named`", atIn([...split.named, "planted@example.test"]));

  console.log(failures === 0 ? "\ncheck-calendar-preview-rules: all passed" : `\ncheck-calendar-preview-rules: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`check-calendar-preview-rules: crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
