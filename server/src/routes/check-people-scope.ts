// Check for GET /captures/people's scope (SAA-260 11-07, the identity window's
// Recent row): real route and real database; the request's sign-in is a
// middleware that sets the access context the capture-token guard would (who
// may call is check-access's business). Names are made up.
//
// People, by the calls they were seen on (attendee or invitee rows):
//   W1  a work call, 01-01          W2  a work call, 01-03 (an invitee row)
//   P1  a personal call, 01-05      B   a work call 01-02 and a personal 01-06
//   U   only a call with no scope   N   on no call
//
//   s1  scope=work, no q: W2, B, W1 (most recently seen on a work call first)
//   s2  scope=personal, no q: B, P1
//   s3  with a scope, someone seen only on a call with no scope, or on no
//       call, is not offered
//   s4  a typed q with a scope gives what the same q gives without one
//   s5  control (unchanged): no scope, no q lists everyone, seen first,
//       those seen on no call last
//   s6  guard (unchanged): an unknown scope, or another parameter, is 400
//
//   scripts/scratch-db.sh run check-people-scope

import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch } from "../extract/fixtures-for-checks.js";
import { errorHandler } from "../lib/http.js";
import { capturePeopleGet } from "./capture-people.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  await refuseUnlessScratch("check-people-scope");
  const fx = await makeAccount("check-people-scope");
  const ctx = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: "check", email: "check@clipwise.test", scope: ["clipwise:capture"] };
  const app = express();
  app.use((req, _res, next) => {
    req.access = ctx as typeof req.access;
    next();
  });
  app.get("/captures/people", capturePeopleGet);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (query: string): Promise<{ status: number; names: string[] }> => {
    const res = await fetch(`${base}/captures/people${query}`);
    const json = (await res.json()) as { people?: Array<{ name: string }> };
    return { status: res.status, names: (json.people ?? []).map((p) => p.name) };
  };

  const tag = fx.tag;
  const person = async (key: string): Promise<{ id: string; name: string }> => {
    const [p] = await db.insert(schema.people).values({ accountId: fx.accountId, email: null, name: `Scope${tag} ${key}` }).returning({ id: schema.people.id, name: schema.people.name });
    return { id: p.id, name: p.name ?? "" };
  };
  const seenOn = async (key: string, scope: "work" | "personal" | null, at: string, p: { id: string }, via: "attendee" | "invitee" = "attendee"): Promise<void> => {
    const id = randomUUID();
    await db.insert(schema.recordings).values({
      id,
      accountId: fx.accountId,
      ownerMemberId: fx.memberId,
      slug: `check-people-scope-${tag}-${key}`,
      title: "check recording",
      source: "check",
      sourceId: id,
      status: "ready",
      visibility: "private",
      scope,
      startedAt: new Date(at),
      metadata: {},
    });
    if (via === "attendee") await db.insert(schema.attendees).values({ recordingId: id, personId: p.id, name: "Guest", isHost: false });
    else await db.insert(schema.invitees).values({ recordingId: id, personId: p.id, email: `inv-${key}-${tag}@clipwise.test`, name: "Guest" });
  };

  try {
    const W1 = await person("W1");
    const W2 = await person("W2");
    const P1 = await person("P1");
    const B = await person("B");
    const U = await person("U");
    const N = await person("N");
    // Dated after anything else in a scratch account, so this account's people
    // come first in a list ordered by when they were seen.
    await seenOn("w1", "work", "2099-01-01T00:00:00Z", W1);
    await seenOn("w2", "work", "2099-01-03T00:00:00Z", W2, "invitee");
    await seenOn("p1", "personal", "2099-01-05T00:00:00Z", P1);
    await seenOn("b-work", "work", "2099-01-02T00:00:00Z", B);
    await seenOn("b-personal", "personal", "2099-01-06T00:00:00Z", B);
    await seenOn("u", null, "2099-01-07T00:00:00Z", U);
    const ours = (names: string[]) => names.filter((n) => n.startsWith(`Scope${tag} `));

    const work = await get("?scope=work");
    check(
      "s1: scope=work, no q: only people seen on a work call, the most recently seen there first (W2, B, W1)",
      work.status === 200 && JSON.stringify(ours(work.names)) === JSON.stringify([W2.name, B.name, W1.name]),
      `${work.status} ${JSON.stringify(ours(work.names))}`,
    );
    const personal = await get("?scope=personal");
    check(
      "s2: scope=personal, no q: B, then P1",
      personal.status === 200 && JSON.stringify(ours(personal.names)) === JSON.stringify([B.name, P1.name]),
      `${personal.status} ${JSON.stringify(ours(personal.names))}`,
    );
    const both = [...work.names, ...personal.names];
    check(
      "s3: with a scope, someone seen only on a call with no scope, or on no call, is not offered",
      work.status === 200 && personal.status === 200 && !both.includes(U.name) && !both.includes(N.name),
      `${work.status}/${personal.status}; U listed ${both.includes(U.name)}, N listed ${both.includes(N.name)}`,
    );
    const typedScoped = await get(`?q=${encodeURIComponent(`Scope${tag}`)}&scope=work`);
    const typed = await get(`?q=${encodeURIComponent(`Scope${tag}`)}`);
    check(
      "s4: a typed q with a scope gives what the same q gives without one",
      // Five: N, on no call, is not a person this member can see (personVisibleTo).
      typedScoped.status === 200 && typed.status === 200 && JSON.stringify(typedScoped.names) === JSON.stringify(typed.names) && typed.names.length === 5,
      `${typedScoped.status} ${JSON.stringify(typedScoped.names)} vs ${typed.status} ${JSON.stringify(typed.names)}`,
    );
    const none = await get("");
    const noneOurs = ours(none.names);
    check(
      "s5: control (unchanged): no scope, no q lists everyone, seen first (U, B, P1, W2, W1), and N, seen on no call, after them if listed",
      none.status === 200 &&
        JSON.stringify(noneOurs.filter((n) => n !== N.name)) === JSON.stringify([U.name, B.name, P1.name, W2.name, W1.name]) &&
        (noneOurs.indexOf(N.name) === -1 || noneOurs.indexOf(N.name) === noneOurs.length - 1),
      `${none.status} ${JSON.stringify(noneOurs)}`,
    );
    const badScope = await get("?scope=both");
    const extra = await get("?q=x&email=y");
    check("s6: guard (unchanged): an unknown scope is 400, and so is another parameter", badScope.status === 400 && extra.status === 400, `${badScope.status} / ${extra.status}`);
  } finally {
    server.close();
    await dropAccount(fx);
    await endPool();
  }
  console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
