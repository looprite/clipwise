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
// The end of the request is afterStore(). It does nothing yet except answer 201.

import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { and, count, eq, sql } from "drizzle-orm";
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

const trackSchema = z.enum(["me", "them"]);

const segmentSchema = z.object({
  track: trackSchema,
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
});

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
    tracks: z.unknown().optional(),
    thresholds: z.unknown().optional(),
  }),
  capture: z.object({
    tracks: z.unknown().optional(),
    permissions: z.object({ tap: z.string().max(32).optional(), mic: z.string().max(32).optional() }),
    triggerApp: z.object({ key: z.string().max(128).optional(), name: z.string().max(256).optional() }).nullable(),
  }),
  content: z.unknown().optional(),
  aec: z.unknown().optional(),
  autostop: z.unknown().optional(),
  identity: identitySchema.optional(),
});

type Stored = {
  recordingId: string;
  transcriptId: string;
  slug: string;
  segmentCount: number;
  excluded: { turnCount: number; bodyChars: number };
  identityApplied: boolean;
};

// What happens once a capture is stored. Nothing yet: the transcript is in the
// database and the recorder is told so. The job that picks it up from here
// replaces the body of this function.
function afterStore(res: Response, stored: Stored): void {
  res.status(201).json({ created: true, ...stored });
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
      if (identity && !identityAlreadyApplied(existing.metadata, identity)) {
        await applyIdentity(tx, existing.id, identity);
        await applySpeakerNames(tx, existing.id, identity);
        await applyScope(tx, existing.id, identity);
        await storeIdentityMetadata(tx, existing.id, identity);
        identityApplied = true;
      }
      return { kind: "repeat" as const, recordingId: existing.id, identityApplied };
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

    return {
      kind: "created" as const,
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
    afterStore(res, outcome.stored);
    return;
  }
  res.status(200).json({ created: false, recordingId: outcome.recordingId, identityApplied: outcome.identityApplied });
});
