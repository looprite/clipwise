// Near-duplicate attendee names (SAA-169). The prompt's known-names picker
// stops *new* typos from being minted; it does nothing about the two that
// already existed ("Liillan Dwyer" next to "Lillian Dwyer", "Manual
// Casella" next to "Manuel Casella") and nothing about a future one that
// somehow still gets typed instead of selected. This is the check the issue
// asks for separately: run it periodically and a distinct-name count that
// grows by a one-or-two-character variant is the signal that would have
// caught "Liillan" on the day it happened rather than a week later.
//
// SAA-260 step 4: names are compared by name key (near-duplicates.ts, the pure
// half, checked without a database by check-near-duplicates.ts), and the names
// are the account's attendee names and its people's names: a person whose name
// was corrected keeps attendee rows under the old spelling, and a typo can now
// live on a person as well as on a row.
//
// Usage:
//   tsx src/pipeline/check-name-duplicates.ts
//
// Read-only: two SELECTs. Exit code 0: no near-duplicate pair found. Exit code
// 1: at least one found, printed to stdout for a human to look at — this never
// merges or edits anything itself. Whether to merge a real duplicate is a
// separate decision (SAA-169's second open question), made by a person looking
// at the specific pair, not by this script picking a winner.

import { and, eq, isNotNull } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { nearDuplicates, type NearDuplicatePair, type SameKeySpellings } from "./near-duplicates.js";

export type { NearDuplicatePair, SameKeySpellings };

export async function findNearDuplicateNames(accountId: string): Promise<{
  distinctCount: number;
  pairs: NearDuplicatePair[];
  sameKey: SameKeySpellings[];
}> {
  const attendeeNames = await db
    .selectDistinct({ name: schema.attendees.name })
    .from(schema.attendees)
    .innerJoin(schema.recordings, eq(schema.recordings.id, schema.attendees.recordingId))
    .where(and(eq(schema.recordings.accountId, accountId), isNotNull(schema.attendees.name)));
  const peopleNames = await db
    .selectDistinct({ name: schema.people.name })
    .from(schema.people)
    .where(and(eq(schema.people.accountId, accountId), isNotNull(schema.people.name)));
  return nearDuplicates([...attendeeNames, ...peopleNames].map((r) => r.name));
}

async function main(): Promise<void> {
  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    throw new Error(
      `expected exactly one account; found ${accounts.length}. Set an explicit account when this stops being the case.`,
    );
  }
  const { distinctCount, pairs, sameKey } = await findNearDuplicateNames(accounts[0].id);
  process.stdout.write(`check-name-duplicates: ${distinctCount} distinct name(s) by key, attendees and people\n`);
  // Information, not a failure: ingest's same-name rule already treats each of
  // these as one person.
  if (sameKey.length === 0) {
    process.stdout.write("check-name-duplicates: no name stored under more than one spelling\n");
  } else {
    process.stdout.write(`check-name-duplicates: ${sameKey.length} name(s) stored under more than one spelling (one person each to ingest; not a failure):\n`);
    for (const s of sameKey) {
      process.stdout.write(`  ${s.spellings.map((x) => JSON.stringify(x)).join(" / ")}\n`);
    }
  }
  if (pairs.length === 0) {
    process.stdout.write("check-name-duplicates: no near-duplicate pairs found\n");
    return;
  }
  process.stdout.write(`check-name-duplicates: ${pairs.length} near-duplicate pair(s) found:\n`);
  for (const p of pairs) {
    process.stdout.write(`  distance ${p.distance}: ${JSON.stringify(p.a)} / ${JSON.stringify(p.b)}\n`);
  }
  process.exitCode = 1;
}

main()
  .catch((err) => {
    process.stderr.write(
      `check-name-duplicates: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
