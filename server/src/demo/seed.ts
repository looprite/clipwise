// The two demo calls every new member starts with (SAA-198 step 6, Jon's calls
// 7 and 10): made-up planning and check-in calls a week apart, so a member can
// ask Claude something on the first day.
//
// Seeded once, right after a membership row is saved (auth/members.ts
// insertMember: add-member and bootstrap-admin alike), never inside that
// insert: a seeding failure is logged by member id and never stops a member
// being added. Members who existed before this never get one.
//
// Copied from demo-call.json (produce.ts made it once, with the real
// extraction and embedding), so seeding calls no model and costs nothing. Each
// call is one private recording owned by the new member, titled as a demo,
// with its transcript, speakers (display names only), segments and moments
// (with their stored embeddings). Nothing else: no people, attendee or invitee
// rows, so no made-up name reaches the team's address book or search's
// attendee filter, and no job, so nothing is extracted, matched or embedded
// again. The moments carry a run id of this recording's own, which search's
// current-run rule needs.
//
// The member removes both from /login (POST /demo/trash, routes/demo.ts); they
// never remove themselves.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import demoCallFile from "./demo-call.json" with { type: "json" };

export const DEMO_SOURCE = "clipwise-demo";

type DemoMoment = {
  kind: string;
  title: string | null;
  summary: string | null;
  start_sec: number;
  end_sec: number;
  score: number | null;
  is_personnel_assessment: boolean;
  metadata: Record<string, unknown>;
  embedding_model: string;
  embedding: number[];
};
type DemoCall = {
  call: number;
  duration_sec: number;
  speakers: Array<{ label: string; display_name: string }>;
  segments: Array<{ order_index: number; speaker: string; start_sec: number; end_sec: number; text: string }>;
  moments: DemoMoment[];
};
type DemoFile = { demo_version: number; calls: DemoCall[] };
const demoFile = demoCallFile as unknown as DemoFile;

// Per call: its title, and how long before seeding it took place, so "what
// changed" reads in order (Jon, 10-13).
export const DEMO_CALLS: Record<number, { title: string; daysBefore: number }> = {
  1: { title: "Demo 1 of 2: Panfold beta planning (sample call, not a real meeting)", daysBefore: 8 },
  2: { title: "Demo 2 of 2: Panfold beta check-in, a week later (sample call, not a real meeting)", daysBefore: 1 },
};

const DAY_MS = 24 * 60 * 60 * 1000;

// One call for one member, in one transaction. source_id "<member id>:<call>"
// under the (account, source, source_id) unique index makes a second seeding of
// the same member a no-op: nothing is written when the recording exists.
async function seedCall(member: { id: string; accountId: string }, call: DemoCall, now: Date): Promise<boolean> {
  const spec = DEMO_CALLS[call.call];
  if (!spec) throw new Error(`demo-call.json has a call ${call.call} with no title`);
  return db.transaction(async (tx) => {
    const runId = randomUUID();
    const startedAt = new Date(now.getTime() - spec.daysBefore * DAY_MS);
    const [recording] = await tx
      .insert(schema.recordings)
      .values({
        accountId: member.accountId,
        ownerMemberId: member.id,
        title: spec.title,
        source: DEMO_SOURCE,
        sourceId: `${member.id}:${call.call}`,
        status: "ready",
        visibility: "private",
        scope: "work",
        durationSec: call.duration_sec,
        startedAt,
        endedAt: new Date(startedAt.getTime() + call.duration_sec * 1000),
        metadata: { demo: true, demo_version: demoFile.demo_version, demo_call: call.call, current_extraction_run: runId },
      })
      .onConflictDoNothing()
      .returning({ id: schema.recordings.id });
    if (!recording) return false;
    const [transcript] = await tx
      .insert(schema.transcripts)
      .values({ recordingId: recording.id, provider: DEMO_SOURCE, language: "en", status: "ready" })
      .returning({ id: schema.transcripts.id });
    const speakerIds = new Map<string, string>();
    for (const s of call.speakers) {
      const [row] = await tx
        .insert(schema.speakers)
        .values({ recordingId: recording.id, label: s.label, displayName: s.display_name })
        .returning({ id: schema.speakers.id });
      speakerIds.set(s.label, row.id);
    }
    await tx.insert(schema.segments).values(
      call.segments.map((s) => ({
        accountId: member.accountId,
        recordingId: recording.id,
        transcriptId: transcript.id,
        speakerId: speakerIds.get(s.speaker) ?? null,
        startSec: s.start_sec,
        endSec: s.end_sec,
        text: s.text,
        orderIndex: s.order_index,
      })),
    );
    await tx.insert(schema.moments).values(
      call.moments.map((m) => ({
        accountId: member.accountId,
        recordingId: recording.id,
        kind: m.kind,
        title: m.title,
        summary: m.summary,
        startSec: m.start_sec,
        endSec: m.end_sec,
        score: m.score,
        isPersonnelAssessment: m.is_personnel_assessment,
        metadata: { ...m.metadata, extraction_run: runId },
        embedding: m.embedding,
        embeddingModel: m.embedding_model,
      })),
    );
    return true;
  });
}

// Right after a membership is saved. Never throws: a failure is one log line,
// by member id, and the member stays added without a demo.
export async function seedDemoForNewMember(member: { id: string; accountId: string }, now = new Date()): Promise<number> {
  let seeded = 0;
  try {
    for (const call of demoFile.calls) {
      if (await seedCall(member, call, now)) seeded++;
    }
    console.log(`demo: seeded ${seeded} demo call(s) for member=${member.id}`);
  } catch (err) {
    console.log(`demo: seeding failed for member=${member.id} (${err instanceof Error ? err.name : "error"}); the member is added without a demo`);
  }
  return seeded;
}

// The member's own live demo calls: how many, and moving them to the trash.
const ownLiveDemos = (member: { memberId: string; accountId: string }) =>
  and(
    eq(schema.recordings.accountId, member.accountId),
    eq(schema.recordings.ownerMemberId, member.memberId),
    eq(schema.recordings.source, DEMO_SOURCE),
    isNull(schema.recordings.trashedAt),
  );

export async function liveDemoCount(member: { memberId: string; accountId: string }): Promise<number> {
  const rows = await db.select({ id: schema.recordings.id }).from(schema.recordings).where(ownLiveDemos(member));
  return rows.length;
}

export async function trashOwnDemos(member: { memberId: string; accountId: string }, now = new Date()): Promise<number> {
  const rows = await db
    .update(schema.recordings)
    .set({ trashedAt: now })
    .where(ownLiveDemos(member))
    .returning({ id: schema.recordings.id });
  return rows.length;
}
