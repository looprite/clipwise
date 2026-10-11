// POST /captures: the recorder hands over one finished capture, and the server
// stores it as a recording owned by whoever the token says.
//
// This is what ingest/clipwise.ts does from the Mac's disk, as an endpoint: one
// transcript, its segments and speakers, the capture's provenance, and the
// identity answer if there is one. Differences that are on purpose:
//   - the account and the owner come from the token (a capture token, SAA-244),
//     never from the body; the server sets source, title placeholder, slug,
//     status and visibility;
//   - the slug is clipwise-capture-<stem>-<first 8 hex of captureId>. The stem is
//     a start time to the second, so two members starting in the same second
//     used to collide on recordings_slug_idx, and every retry collided again;
//   - it is idempotent on (account, source, source_id), enforced by the unique
//     index recordings_account_source_idx and not by read-then-insert.
//
// A repeat of a capture already stored:
//   same content          200 {created:false}; nothing written, except that an
//                         identity answer the first request did not carry is
//                         applied, once
//   different segments    409 capture_content_conflict; the row is unchanged
//   another member's id   409 capture_id_taken; the row is unchanged
// "Same content" is a SHA-256 of the segments as sent (metadata.capture.content_hash).
//
// The extraction job is queued in the same transaction as the capture, so a stored
// capture always has one. The end of the request is afterStore(): answer 201, then
// wake the worker. A repeat creates no job, except that an identity answer which
// names a speaker after extraction has started or finished queues a re-extract
// (jobs/enqueue.ts has the cases).

import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { accessOf } from "../access/authenticate.js";
import { db, schema } from "../db/index.js";
import { CLIPWISE_SOURCE, titlePlaceholderFor } from "../ingest/clipwise.js";
import {
  applyIdentity,
  applyScope,
  applySpeakerNames,
  identityAlreadyApplied,
  storeIdentityMetadata,
  type IdentityAnswer,
} from "../ingest/identity.js";
import { countObservedFidelity, sourceFidelitySchema } from "../lib/fidelity.js";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { slugify } from "../lib/slug.js";
import { BANDS, TRACK_LABELS, TRACK_NAMES, TRACK_VERDICTS } from "../pipeline/classify-capture.js";
import { voiceLabel } from "../pipeline/diarize.js";
import { enqueueJob, enqueueReextractForLateNames } from "../jobs/enqueue.js";
import { wakeWorker } from "../jobs/registry.js";

const trackSchema = z.enum(["me", "them"]);

// voiceIndex: the diarized voice the Mac assigned a `them` segment to (SAA-227
// decision 1); absent when no voice covers most of it. Strict, like the voice
// entries below: what diarize knows beyond the index and the totals (turn times,
// clip ranges, embeddings) never comes in, and a body carrying it is refused
// rather than quietly stripped.
const segmentSchema = z
  .object({
    track: trackSchema,
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    text: z.string(),
    voiceIndex: z.number().int().positive().optional(),
  })
  .strict();

const voiceSchema = z.object({ voiceIndex: z.number().int().positive(), totalSeconds: z.number().nonnegative() }).strict();

// The recorder's identity answer (ingest/identity.ts IdentityAnswer), as the
// prompt writes it.
const identitySchema = z.object({
  identity_version: z.number().int().optional(),
  recording_id: z.string().max(64).optional(),
  stem: z.string().max(200).optional(),
  answered_at: z.string().max(64).optional(),
  self: z
    .object({ name: z.string().max(256).nullable().optional(), source: z.string().max(64).optional() })
    .nullable()
    .optional(),
  guests: z.array(z.object({ name: z.string().max(256).nullable().optional() })).max(50).nullable().optional(),
  scope: z.enum(["work", "personal"]).nullable().optional(),
});

// capture.tracks is the capture manifest's `tracks`, as the recorder writes it:
// recorder/app/main.js buildManifest (:466-502) makes the array of two, one per
// track, and the stop-time readbacks add to each: finalizeMicFormat (:566-583,
// frames, data_bytes and duration_s from the finished WAV) and the tap's
// (:640-654, duration_s is null when the length could not be worked out). The
// fields below are the ones always there at the start (the first six) and the ones
// the server reads or that are numbers by construction; everything else the
// recorder adds is kept as sent. The promotion reads duration_s (extract.ts
// CAPTURE_DURATION_SEC), so a value that is not a number is refused here and
// never stored.
const manifestTrackSchema = z
  .object({
    track: z.enum(["system", "mic"]),
    file: z.string().max(512),
    encoding: z.string().max(32),
    container: z.string().max(32),
    sample_rate: z.number(),
    sample_rate_source: z.string().max(64),
    channels: z.number().int().optional(),
    device_name: z.string().max(512).nullable().optional(),
    device_uid: z.string().max(512).nullable().optional(),
    frames: z.number().int().nonnegative().nullable().optional(),
    data_bytes: z.number().int().nonnegative().nullable().optional(),
    duration_s: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();
const manifestTracksSchema = z.array(manifestTrackSchema).max(8);

// classification.tracks is pipeline/classify-capture.ts's CaptureClassification
// .tracks: one TrackReport per input track, keyed tap and mic. deniedTrack below
// reads tap.verdict and mic.verdict.
const trackReportSchema = z
  .object({
    track: z.enum(TRACK_NAMES),
    label: z.enum(TRACK_LABELS),
    band: z.enum(BANDS),
    verdict: z.enum(TRACK_VERDICTS),
    permission: z.string().max(64),
    rms: z.number(),
    peak: z.number(),
    nonzero_fraction: z.number(),
    duration_s: z.number(),
    gaps: z.array(z.object({ start_s: z.number(), end_s: z.number(), duration_s: z.number() })).max(10_000),
    note: z.string().max(4000),
  })
  .passthrough();
const classificationTracksSchema = z.object({ tap: trackReportSchema, mic: trackReportSchema }).passthrough();

const captureSchema = z.object({
  // Manifest ids are uppercase UUIDs (recorder/app/main.js); the check is
  // case-insensitive and the id is stored as sent, as ingest stores it.
  captureId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  stem: z.string().min(1).max(200),
  engine: z.string().min(1).max(64),
  model: z.string().max(256),
  language: z.string().max(16).optional(),
  segments: z.array(segmentSchema),
  sourceFidelity: sourceFidelitySchema,
  classification: z.object({
    verdict: z.string().max(64),
    concern: z.boolean(),
    reason: z.string().max(4000),
    excludedLabels: z.array(trackSchema),
    tracks: classificationTracksSchema.optional(),
    thresholds: z.unknown().optional(),
  }),
  capture: z.object({
    tracks: manifestTracksSchema.optional(),
    permissions: z.object({ tap: z.string().max(32).optional(), mic: z.string().max(32).optional() }),
    triggerApp: z.object({ key: z.string().max(128).optional(), name: z.string().max(256).optional() }).nullable(),
  }),
  content: z.unknown().optional(),
  aec: z.unknown().optional(),
  autostop: z.unknown().optional(),
  identity: identitySchema.optional(),
  // Each voice diarize kept, with its total seconds. A segment's voiceIndex must
  // name one of them, and only a `them` segment carries one.
  voices: z.array(voiceSchema).max(64).optional(),
}).superRefine((body, ctx) => {
  const listed = new Set((body.voices ?? []).map((v) => v.voiceIndex));
  if (listed.size !== (body.voices ?? []).length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["voices"], message: "a voiceIndex is listed twice" });
  }
  body.segments.forEach((s, i) => {
    if (s.voiceIndex === undefined) return;
    if (s.track !== "them") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["segments", i, "voiceIndex"], message: "only a them segment has a voice" });
    } else if (!listed.has(s.voiceIndex)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["segments", i, "voiceIndex"], message: "not one of the listed voices" });
    }
  });
});

type Stored = {
  recordingId: string;
  transcriptId: string;
  slug: string;
  segmentCount: number;
  excluded: { turnCount: number; bodyChars: number };
  identityApplied: boolean;
};

// What happens once a capture is stored and its job committed: the recorder is
// told, then the worker is woken in this process. Ids only in the log.
function afterStore(res: Response, stored: Stored, jobId: string | null): void {
  res.status(201).json({ created: true, ...stored });
  logQueued(jobId, stored.recordingId, "extract");
  wakeWorker();
}

function logQueued(jobId: string | null, recordingId: string, kind: string): void {
  if (jobId) console.log(`jobs: ${jobId} recording=${recordingId} kind=${kind} queued`);
}

// The first 8 hex digits of the capture id, lowercase.
const idPrefix = (captureId: string): string => captureId.replace(/-/g, "").slice(0, 8).toLowerCase();
export const captureSlug = (stem: string, captureId: string): string =>
  `clipwise-capture-${slugify(stem)}-${idPrefix(captureId)}`;

// A permission the user denied is not the same as a quiet meeting
// (SAA-150/183): see ingest/clipwise.ts, which has the same refusal.
function deniedTrack(tracks: unknown): "tap" | "mic" | null {
  if (!tracks || typeof tracks !== "object") return null;
  for (const track of ["tap", "mic"] as const) {
    const t = (tracks as Record<string, unknown>)[track];
    const verdict = t && typeof t === "object" ? (t as Record<string, unknown>).verdict : undefined;
    if (verdict === "dead_denied") return track;
  }
  return null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The diarize split on the server (SAA-227 decision 4), with pipeline/diarize.ts's
// gates. The Mac did the assignment (assignVoice, majority rule) and sent each
// `them` segment's voice index; this writes it. No split for one voice or none,
// for a recording with no `them` row, or when `them` is already named (an answer
// naming exactly one guest outranks an unassisted voice count). A Voice N row for
// each voice listed; each segment with a voice index moves to its row; `them` is
// deleted only when no segment stayed on it, since deleting it would set the
// remaining segments' speaker to null.
async function splitThemByVoice(
  tx: Tx,
  recordingId: string,
  voices: z.infer<typeof voiceSchema>[],
  kept: z.infer<typeof segmentSchema>[],
): Promise<void> {
  if (voices.length <= 1) return;
  const [them] = await tx
    .select({ id: schema.speakers.id, displayName: schema.speakers.displayName })
    .from(schema.speakers)
    .where(and(eq(schema.speakers.recordingId, recordingId), eq(schema.speakers.label, "them")));
  if (!them || them.displayName) return;

  const speakerByVoice = new Map<number, string>();
  for (const v of voices) {
    const [row] = await tx
      .insert(schema.speakers)
      .values({ recordingId, label: voiceLabel(v.voiceIndex) })
      .returning({ id: schema.speakers.id });
    speakerByVoice.set(v.voiceIndex, row.id);
  }
  // orderIndex is the segment's place in `kept`, as inserted above.
  const orderByVoice = new Map<number, number[]>();
  let keptOnThem = false;
  kept.forEach((s, idx) => {
    if (s.track !== "them") return;
    if (s.voiceIndex === undefined) {
      keptOnThem = true;
      return;
    }
    orderByVoice.set(s.voiceIndex, [...(orderByVoice.get(s.voiceIndex) ?? []), idx]);
  });
  for (const [voiceIndex, orders] of orderByVoice) {
    await tx
      .update(schema.segments)
      .set({ speakerId: speakerByVoice.get(voiceIndex) })
      .where(and(eq(schema.segments.recordingId, recordingId), inArray(schema.segments.orderIndex, orders)));
  }
  if (!keptOnThem) await tx.delete(schema.speakers).where(eq(schema.speakers.id, them.id));
}

const contentHashOf = (segments: z.infer<typeof segmentSchema>[]): string =>
  createHash("sha256")
    .update(JSON.stringify(segments.map((s) => [s.track, s.startMs, s.endMs, s.text])))
    .digest("hex");

export const capturesPost: RequestHandler = asyncHandler(async (req, res) => {
  const ctx = accessOf(req);
  const body = parseBody(captureSchema, req);

  // Fidelity runs before any database work: a mismatch never partially writes.
  const observed = countObservedFidelity(body.segments);
  const declared = body.sourceFidelity;
  if (observed.turnCount !== declared.declaredTurnCount || observed.bodyChars !== declared.declaredBodyChars) {
    throw new HttpError(422, "transcript_fidelity_mismatch", {
      declaredTurnCount: declared.declaredTurnCount,
      observedTurnCount: observed.turnCount,
      turnCountDelta: observed.turnCount - declared.declaredTurnCount,
      declaredBodyChars: declared.declaredBodyChars,
      observedBodyChars: observed.bodyChars,
      bodyCharsDelta: observed.bodyChars - declared.declaredBodyChars,
      countedFrom: declared.countedFrom,
    });
  }

  // A track the classifier found no audio on is left out of the segments and kept
  // whole in metadata.capture_quality (ingest/clipwise.ts has the reasoning).
  const excludedLabels = new Set(body.classification.excludedLabels);
  const kept = body.segments.filter((s) => !excludedLabels.has(s.track));
  const dropped = body.segments.filter((s) => excludedLabels.has(s.track));
  if (body.segments.length === 0) {
    const denied = deniedTrack(body.classification.tracks);
    if (denied) throw new HttpError(422, "capture_permission_denied", { track: denied });
  }
  if (body.segments.length > 0 && kept.length === 0) throw new HttpError(422, "capture_every_segment_excluded");
  const excluded = {
    turnCount: dropped.length,
    bodyChars: dropped.reduce((n, s) => n + s.text.length, 0),
  };

  const sourceId = body.captureId;
  const contentHash = contentHashOf(body.segments);
  const identity = (body.identity ?? null) as IdentityAnswer | null;
  const slug = captureSlug(body.stem, body.captureId);
  const labelSet = new Set(kept.map((s) => s.track));
  const engine = body.engine;

  const outcome = await db.transaction(async (tx) => {
    const [recording] = await tx
      .insert(schema.recordings)
      .values({
        accountId: ctx.accountId,
        ownerMemberId: ctx.memberId,
        slug,
        title: titlePlaceholderFor(body.stem),
        source: CLIPWISE_SOURCE,
        sourceId,
        startedAt: new Date(body.startedAt),
        status: "pending",
        visibility: "private",
        metadata: {
          transcript_source_path: null,
          inputs: null,
          downsampled: null,
          whisper_model: engine === "whisper.cpp" ? body.model : null,
          aec: body.aec ?? null,
          autostop: body.autostop ?? null,
          transcription_engine: engine,
          transcription_model: body.model,
          content: body.content ?? null,
          capture_quality: {
            verdict: body.classification.verdict,
            concern: body.classification.concern,
            reason: body.classification.reason,
            excluded_labels: body.classification.excludedLabels,
            excluded_counts: excluded,
            tracks: body.classification.tracks ?? null,
            thresholds: body.classification.thresholds ?? null,
            dropped_segments: dropped.map((s) => ({ track: s.track, start_ms: s.startMs, end_ms: s.endMs, text: s.text })),
          },
          capture: {
            manifest_file: null,
            stem: body.stem,
            started_at: body.startedAt,
            tracks: body.capture.tracks ?? null,
            permissions: body.capture.permissions,
            trigger_app: body.capture.triggerApp,
            content_hash: contentHash,
          },
          identity,
        },
      })
      .onConflictDoNothing({
        target: [schema.recordings.accountId, schema.recordings.source, schema.recordings.sourceId],
      })
      .returning();

    if (!recording) {
      // The capture is already stored (the unique index refused the insert; this
      // transaction has written nothing). Lock the row, so two requests carrying
      // the same late identity answer apply it once between them.
      const [existing] = await tx
        .select()
        .from(schema.recordings)
        .where(
          and(
            eq(schema.recordings.accountId, ctx.accountId),
            eq(schema.recordings.source, CLIPWISE_SOURCE),
            eq(schema.recordings.sourceId, sourceId),
          ),
        )
        .for("update");
      if (!existing) throw new Error("capture insert conflicted but no row was found");
      if (existing.ownerMemberId !== ctx.memberId) throw new HttpError(409, "capture_id_taken");
      const storedHash = (existing.metadata as { capture?: { content_hash?: unknown } } | null)?.capture?.content_hash;
      if (storedHash !== contentHash) throw new HttpError(409, "capture_content_conflict");

      let identityApplied = false;
      let reextractJobId: string | null = null;
      if (identity && !identityAlreadyApplied(existing.metadata, identity)) {
        await applyIdentity(tx, existing.id, identity);
        const mapping = await applySpeakerNames(tx, existing.id, identity);
        await applyScope(tx, existing.id, identity);
        await storeIdentityMetadata(tx, existing.id, identity);
        identityApplied = true;
        // Only a speaker name actually written changes what extraction would see.
        if (mapping.applied.length > 0) {
          reextractJobId = await enqueueReextractForLateNames(tx, existing);
        }
      }
      return { kind: "repeat" as const, recordingId: existing.id, identityApplied, reextractJobId };
    }

    const [transcript] = await tx
      .insert(schema.transcripts)
      .values({
        recordingId: recording.id,
        provider: engine,
        language: body.language ?? "en",
        text: null,
        status: "ready",
      })
      .returning();

    // Only for labels actually present: a `them` speaker with no segments would
    // assert a participant who contributed nothing.
    const speakerByLabel = new Map<string, string>();
    for (const label of ["me", "them"] as const) {
      if (!labelSet.has(label)) continue;
      const [speaker] = await tx.insert(schema.speakers).values({ recordingId: recording.id, label }).returning();
      speakerByLabel.set(label, speaker.id);
    }

    // drizzle's .values() throws on an empty array, and a capture with no speech
    // is a real recording (SAA-150).
    if (kept.length > 0) {
      await tx.insert(schema.segments).values(
        kept.map((s, idx) => ({
          accountId: ctx.accountId,
          recordingId: recording.id,
          transcriptId: transcript.id,
          speakerId: speakerByLabel.get(s.track),
          startSec: s.startMs / 1000,
          endSec: s.endMs / 1000,
          text: s.text,
          orderIndex: idx,
        })),
      );
    }

    if (identity) {
      await applyIdentity(tx, recording.id, identity);
      await applySpeakerNames(tx, recording.id, identity);
      await applyScope(tx, recording.id, identity);
    }

    // After identity, as on the Mac (ingest, then diarize): an answer that names
    // the one guest has named `them` by now, and that stops the split.
    await splitThemByVoice(tx, recording.id, body.voices ?? [], kept);

    // Read back from the database, not the ORM's report: what is stored is what
    // was declared (less the deliberate exclusions), or nothing is stored.
    const [stored] = await tx
      .select({
        turnCount: count(),
        bodyChars: sql<number>`coalesce(sum(char_length(${schema.segments.text})), 0)::bigint`,
      })
      .from(schema.segments)
      .where(eq(schema.segments.recordingId, recording.id));
    const expected = countObservedFidelity(kept);
    if (Number(stored.turnCount) !== expected.turnCount || Number(stored.bodyChars) !== expected.bodyChars) {
      throw new Error(
        `capture fidelity readback: expected ${expected.turnCount}/${expected.bodyChars}, stored ${stored.turnCount}/${stored.bodyChars}`,
      );
    }

    const jobId = await enqueueJob(tx, { accountId: ctx.accountId, recordingId: recording.id, kind: "extract" });

    return {
      kind: "created" as const,
      jobId,
      stored: {
        recordingId: recording.id,
        transcriptId: transcript.id,
        slug,
        segmentCount: Number(stored.turnCount),
        excluded,
        identityApplied: identity !== null,
      } satisfies Stored,
    };
  });

  if (outcome.kind === "created") {
    afterStore(res, outcome.stored, outcome.jobId);
    return;
  }
  res.status(200).json({ created: false, recordingId: outcome.recordingId, identityApplied: outcome.identityApplied });
  logQueued(outcome.reextractJobId, outcome.recordingId, "re_extract");
  if (outcome.reextractJobId) wakeWorker();
});
