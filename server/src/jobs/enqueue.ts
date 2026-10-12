// Putting work in the jobs table. Always inside the transaction that makes the
// work necessary, so a capture and its job exist together or not at all.

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { TERMINAL_STATUS } from "../extract/extract.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type JobKind = "extract" | "re_extract" | "match";

// The new job's id, or null when one of this kind is already queued or running
// for the recording (the partial unique index refuses it; nothing is written).
export async function enqueueJob(
  executor: typeof db | Tx,
  job: { accountId: string; recordingId: string; kind: JobKind },
): Promise<string | null> {
  const [row] = await executor.insert(schema.jobs).values(job).onConflictDoNothing().returning({ id: schema.jobs.id });
  return row?.id ?? null;
}

// A late identity answer has just written a speaker name on a recording the
// caller holds locked. Does extraction need to run again for it? Decided by where
// the first extraction is:
//   complete (ready, with a current run)   yes: that run was built on unnamed
//                                          speakers
//   its job is running                     yes: it may have read the speakers
//                                          before the answer; it has its own
//                                          check at the end (runExtraction's
//                                          speaker fingerprint) but the answer
//                                          can land after that check and before
//                                          the promotion, and then nothing else
//                                          would ever run. If it did catch it,
//                                          the re-extract finds the promoted run
//                                          already built on these names and does
//                                          nothing
//   its job is queued                      no: it reads the speakers when it runs
//   anything else (failed, no job)         no: nothing is extracting this
//                                          recording, and one name does not
//                                          change that
export async function enqueueReextractForLateNames(
  tx: Tx,
  recording: { id: string; accountId: string; status: string; metadata: unknown },
): Promise<string | null> {
  const currentRun = (recording.metadata as { current_extraction_run?: unknown } | null)?.current_extraction_run;
  const complete = recording.status === TERMINAL_STATUS && typeof currentRun === "string";
  if (!complete) {
    const [running] = await tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.recordingId, recording.id), eq(schema.jobs.kind, "extract"), eq(schema.jobs.state, "running")));
    if (!running) return null;
  }
  return enqueueJob(tx, { accountId: recording.accountId, recordingId: recording.id, kind: "re_extract" });
}
