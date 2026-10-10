// Rows for the checks that run extraction against a database: a throwaway
// account with one member and recordings with segments, deleted at the end.
//
// Refuses to do anything unless the run came through scratch-db.sh
// (CLIPWISE_CHECK_SCRATCH_DB=1) and the database it reaches is not main's
// (endpoint ep-wild-unit-af7bwrtc), by the host in DATABASE_URL and by the
// endpoint the server itself reports.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";

const MAIN_ENDPOINT = "ep-wild-unit-af7bwrtc";

export async function refuseUnlessScratch(who: string): Promise<void> {
  if (process.env.CLIPWISE_CHECK_SCRATCH_DB !== "1") {
    process.stderr.write(`${who}: refusing to run — it writes to the database. Run it through scripts/scratch-db.sh.\n`);
    process.exit(2);
  }
  const url = process.env.DATABASE_URL ?? "";
  if (url.includes(MAIN_ENDPOINT)) {
    process.stderr.write(`${who}: refusing — DATABASE_URL names main's endpoint\n`);
    process.exit(3);
  }
  const r = await pool.query("select current_setting('neon.endpoint_id', true) as ep");
  const ep = r.rows[0]?.ep as string | null;
  if (!ep || ep === MAIN_ENDPOINT) {
    process.stderr.write(`${who}: refusing — the database reports endpoint ${ep ?? "(none)"}\n`);
    process.exit(3);
  }
}

export type Fixture = { accountId: string; memberId: string; tag: string };

export async function makeAccount(prefix: string): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const [account] = await db.insert(schema.accounts).values({ name: `${prefix} ${tag}`, slug: `${prefix}-${tag}` }).returning();
  const [member] = await db
    .insert(schema.accountMembers)
    .values({ accountId: account.id, email: `${prefix}-${tag}@clipwise.test`, role: "member", joinedAt: new Date() })
    .returning();
  return { accountId: account.id, memberId: member.id, tag };
}

export async function dropAccount(fx: Fixture): Promise<void> {
  // recordings (and with them moments, segments, speakers, attendees, jobs)
  // go with the account; the member row has a RESTRICT reference from recordings.
  await db.delete(schema.recordings).where(eq(schema.recordings.accountId, fx.accountId));
  await db.delete(schema.accounts).where(eq(schema.accounts.id, fx.accountId));
}

// A pending recording with `segments` segments, as POST /captures leaves it
// before extraction. Returns its id.
export async function makeRecording(
  fx: Fixture,
  opts: { segments: number; attendeeName?: string },
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.recordings).values({
    id,
    accountId: fx.accountId,
    ownerMemberId: fx.memberId,
    slug: `check-${fx.tag}-${id.slice(0, 8)}`,
    title: "check recording",
    source: "check",
    sourceId: id,
    status: "pending",
    visibility: "private",
    metadata: {},
  });
  const [transcript] = await db
    .insert(schema.transcripts)
    .values({ recordingId: id, provider: "check", language: "en", status: "ready" })
    .returning();
  const [me] = await db.insert(schema.speakers).values({ recordingId: id, label: "me" }).returning();
  const [them] = await db.insert(schema.speakers).values({ recordingId: id, label: "them" }).returning();
  if (opts.segments > 0) {
    await db.insert(schema.segments).values(
      Array.from({ length: opts.segments }, (_, i) => ({
        accountId: fx.accountId,
        recordingId: id,
        transcriptId: transcript.id,
        speakerId: i % 2 === 0 ? me.id : them.id,
        startSec: i * 10,
        endSec: i * 10 + 9,
        text: `segment ${i} of the check recording`,
        orderIndex: i,
      })),
    );
  }
  if (opts.attendeeName) {
    await db.insert(schema.attendees).values({ recordingId: id, name: opts.attendeeName, isHost: false });
  }
  return id;
}

export async function endPool(): Promise<void> {
  await pool.end();
}

export { sql };
