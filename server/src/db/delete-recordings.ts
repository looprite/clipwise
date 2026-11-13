// Deleting recordings permanently: the one place it is done (SAA-289). The
// recorder's "Delete permanently" (DELETE /captures/:captureId, from the trash)
// and the host's delete-member-calls (src/auth/cli.ts) both come here, and so
// will a team admin's at Gate 2.
//
// Every row that references a recording goes with it, by the foreign keys' ON
// DELETE CASCADE: transcripts, speakers, segments, moments, clips, attendees,
// invitees, shares and jobs, and the shares of its clips (check-access 18f finds
// them in pg_constraint). In the same transaction, each person the recordings'
// attendees, speakers or invitees pointed at that nothing points at any more is
// deleted (attendee-people.ts dropReleasedPeople; check-access 18f and 18g).
//
// `filter` picks the recordings, within `accountId`, and is required: without
// it, and() would match every recording of the account. It is checked at run
// time too, before any query, since a caller in JavaScript or behind a cast can
// pass nothing whatever the type says.
//
// The people are read before the delete, since the cascade takes the rows that
// point at them. The delete repeats the filter, so a recording that stopped
// matching in between (a restore from the trash landing first) stays, and is not
// counted. A person read for it is only deleted if nothing points at them, so
// that costs nothing.

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, schema } from "./index.js";
import { dropReleasedPeople } from "../ingest/attendee-people.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function deleteRecordings(
  tx: Tx,
  accountId: string,
  filter: SQL,
): Promise<{ recordingIds: string[]; peopleReleased: number }> {
  if (!filter) throw new Error("deleteRecordings: a filter is required");
  const r = schema.recordings;
  const where = and(eq(r.accountId, accountId), filter);
  const ids = (await tx.select({ id: r.id }).from(r).where(where)).map((x) => x.id);
  if (ids.length === 0) return { recordingIds: [], peopleReleased: 0 };
  const pointedAt = await tx.execute(sql`
    select person_id from ${schema.attendees} where ${inArray(schema.attendees.recordingId, ids)} and ${schema.attendees.personId} is not null
    union select person_id from ${schema.speakers} where ${inArray(schema.speakers.recordingId, ids)} and ${schema.speakers.personId} is not null
    union select person_id from ${schema.invitees} where ${inArray(schema.invitees.recordingId, ids)} and ${schema.invitees.personId} is not null`);
  const gone = await tx
    .delete(r)
    .where(and(where, inArray(r.id, ids)))
    .returning({ id: r.id });
  if (gone.length === 0) return { recordingIds: [], peopleReleased: 0 };
  const peopleReleased = await dropReleasedPeople(tx, accountId, pointedAt.rows.map((x) => String(x.person_id)));
  return { recordingIds: gone.map((x) => x.id), peopleReleased };
}
