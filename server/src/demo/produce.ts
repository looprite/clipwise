// Makes the two demo calls' moments and embeddings once (SAA-198 step 6, Jon's
// calls 7 and 10), so seeding a new member's demo costs nothing: no model is
// called per member, rows are copied from the file this writes.
//
// From src/demo/demo-script.txt and demo-script-2.txt (made-up calls a week
// apart: no real people or companies), it builds each call as a recording on
// the scratch branch the way a capture is stored (transcript, speakers with
// display names, segments timed at 150 words a minute), runs the real
// extraction (extract.ts) and the real embedding (Voyage, as every moment
// gets), and writes src/demo/demo-call.json: per call, the segments, the
// speakers, and the moments search would show (collapse and current-run rules
// applied), each with its embedding; and one produced block for the run. The
// models are recorded from the requests actually sent, and the API usage from
// the replies. The throwaway account and its rows are deleted at the end.
//
// Both calls are made in every run, so the file is always one run's output.
// It is reviewed and committed by hand. Running this again is the only way the
// demo changes.
//
// Usage (through the guard, with the two keys from dev.env):
//   scripts/scratch-db.sh demo-produce

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runExtraction } from "../extract/extract.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CALLS = [
  { call: 1, script: "demo-script.txt" },
  { call: 2, script: "demo-script-2.txt" },
];
const OUT = join(HERE, "demo-call.json");
const DEMO_VERSION = 2;
const WORDS_PER_MINUTE = 150;
const PAUSE_SEC = 0.4;

type Turn = { speaker: string; text: string };

function readScript(file: string): Turn[] {
  return readFileSync(join(HERE, file), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([A-Z][a-z]+): (.+)$/.exec(line);
      if (!m) throw new Error(`${file}: a line is not "Name: text": ${line.slice(0, 40)}`);
      return { speaker: m[1], text: m[2] };
    });
}

// The usage and the models, read from what was actually sent and received.
const usage = {
  anthropic: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, models: new Set<string>() },
  voyage: { requests: 0, totalTokens: 0, models: new Set<string>(), dimensions: new Set<number>() },
};
const realFetch = globalThis.fetch;
const countingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const sent = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  const res = await realFetch(input, init);
  if (url.startsWith("https://api.anthropic.com/")) {
    usage.anthropic.requests++;
    if (typeof sent?.model === "string") usage.anthropic.models.add(sent.model);
    const reply = (await res.clone().json().catch(() => null)) as { usage?: Record<string, number> } | null;
    usage.anthropic.inputTokens += reply?.usage?.input_tokens ?? 0;
    usage.anthropic.outputTokens += reply?.usage?.output_tokens ?? 0;
    usage.anthropic.cacheReadTokens += reply?.usage?.cache_read_input_tokens ?? 0;
    usage.anthropic.cacheWriteTokens += reply?.usage?.cache_creation_input_tokens ?? 0;
  } else if (url.startsWith("https://api.voyageai.com/")) {
    usage.voyage.requests++;
    if (typeof sent?.model === "string") usage.voyage.models.add(sent.model);
    const reply = (await res.clone().json().catch(() => null)) as { usage?: { total_tokens?: number }; data?: Array<{ embedding?: number[] }> } | null;
    usage.voyage.totalTokens += reply?.usage?.total_tokens ?? 0;
    for (const d of reply?.data ?? []) if (Array.isArray(d.embedding)) usage.voyage.dimensions.add(d.embedding.length);
  }
  return res;
};

// Moment metadata that names this run's rows: ids that mean nothing once the
// rows are copied into another account. Everything else is kept.
const ID_KEYS = new Set(["extraction_run", "collapsed_into", "merged_from"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function portableMetadata(meta: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (ID_KEYS.has(k)) continue;
    if (typeof v === "string" && UUID.test(v)) continue;
    out[k] = v;
  }
  return out;
}

// One call: stored as a capture would be, extracted and embedded for real, and
// read back as search would show it.
async function produceCall(fx: Fixture, call: number, script: string) {
  const turns = readScript(script);
  const recordingId = randomUUID();
  await db.insert(schema.recordings).values({
    id: recordingId,
    accountId: fx.accountId,
    ownerMemberId: fx.memberId,
    slug: `demo-produce-${fx.tag}-${call}`,
    title: `demo-produce ${call}`,
    source: "demo-produce",
    sourceId: recordingId,
    status: "pending",
    visibility: "private",
    scope: "work",
    metadata: {},
  });
  const [transcript] = await db
    .insert(schema.transcripts)
    .values({ recordingId, provider: "clipwise-demo", language: "en", status: "ready" })
    .returning();
  const names = [...new Set(turns.map((t) => t.speaker))];
  const speakerIds = new Map<string, string>();
  for (const name of names) {
    const [s] = await db.insert(schema.speakers).values({ recordingId, label: name.toLowerCase(), displayName: name }).returning();
    speakerIds.set(name, s.id);
  }
  let at = 0;
  const segments = turns.map((t, i) => {
    const words = t.text.split(/\s+/).length;
    const startSec = Math.round(at * 10) / 10;
    const endSec = Math.round((at + (words / WORDS_PER_MINUTE) * 60) * 10) / 10;
    at = endSec + PAUSE_SEC;
    return { orderIndex: i, speaker: t.speaker, startSec, endSec, text: t.text };
  });
  await db.insert(schema.segments).values(
    segments.map((s) => ({
      accountId: fx.accountId,
      recordingId,
      transcriptId: transcript.id,
      speakerId: speakerIds.get(s.speaker)!,
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
      orderIndex: s.orderIndex,
    })),
  );
  const durationSec = segments[segments.length - 1].endSec;
  console.log(`demo-produce: call ${call}: ${turns.length} turns, ${names.length} speakers, ${durationSec.toFixed(1)} s`);

  const result = await runExtraction(recordingId, { client: new Anthropic({ fetch: countingFetch }) });
  console.log(`demo-produce: call ${call}: extraction done, ${result.momentsVisibleAfterCollapse} moment(s) visible after collapse`);

  const [rec] = await db.select({ metadata: schema.recordings.metadata }).from(schema.recordings).where(eq(schema.recordings.id, recordingId));
  const currentRun = (rec.metadata as Record<string, unknown> | null)?.current_extraction_run;
  const rows = await db
    .select()
    .from(schema.moments)
    .where(
      and(
        eq(schema.moments.recordingId, recordingId),
        sql`(${schema.moments.metadata}->>'collapsed_into') IS NULL`,
        sql`(${schema.moments.metadata}->>'extraction_run') = ${String(currentRun)}`,
      ),
    )
    .orderBy(schema.moments.startSec);
  const metadataKeys = new Set<string>();
  for (const r of rows) for (const k of Object.keys((r.metadata as Record<string, unknown>) ?? {})) metadataKeys.add(k);
  console.log(`demo-produce: call ${call}: moment metadata keys seen: ${[...metadataKeys].sort().join(", ")}`);
  const missingEmbedding = rows.filter((r) => !r.embedding || !r.embeddingModel).length;
  if (missingEmbedding > 0) throw new Error(`call ${call}: ${missingEmbedding} moment(s) have no embedding; nothing written`);

  return {
    call,
    duration_sec: durationSec,
    speakers: names.map((n) => ({ label: n.toLowerCase(), display_name: n })),
    segments: segments.map((s) => ({ order_index: s.orderIndex, speaker: s.speaker.toLowerCase(), start_sec: s.startSec, end_sec: s.endSec, text: s.text })),
    moments: rows.map((r) => ({
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      start_sec: r.startSec,
      end_sec: r.endSec,
      score: r.score,
      is_personnel_assessment: r.isPersonnelAssessment,
      metadata: portableMetadata(r.metadata as Record<string, unknown> | null),
      embedding_model: r.embeddingModel,
      embedding: r.embedding,
    })),
  };
}

async function main(): Promise<void> {
  await refuseUnlessScratch("demo-produce");
  globalThis.fetch = countingFetch;
  const fx = await makeAccount("demo-produce");
  try {
    const calls = [];
    for (const c of CALLS) calls.push(await produceCall(fx, c.call, c.script));

    let commit = "unknown";
    let dirty = false;
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).trim();
      dirty = execFileSync("git", ["status", "--porcelain"], { cwd: HERE, encoding: "utf8" }).trim().length > 0;
    } catch {}

    const out = {
      demo_version: DEMO_VERSION,
      produced: {
        at: new Date().toISOString(),
        commit,
        dirty,
        extraction_models: [...usage.anthropic.models].sort(),
        embedding_models: [...usage.voyage.models].sort(),
        embedding_dimensions: [...usage.voyage.dimensions].sort(),
        usage: {
          anthropic: {
            requests: usage.anthropic.requests,
            input_tokens: usage.anthropic.inputTokens,
            output_tokens: usage.anthropic.outputTokens,
            cache_read_input_tokens: usage.anthropic.cacheReadTokens,
            cache_creation_input_tokens: usage.anthropic.cacheWriteTokens,
          },
          voyage: { requests: usage.voyage.requests, total_tokens: usage.voyage.totalTokens },
        },
      },
      calls,
    };
    writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
    console.log(`demo-produce: wrote ${OUT.slice(OUT.indexOf("src/"))}: ${calls.map((c) => `call ${c.call} ${c.moments.length} moment(s)`).join(", ")}`);
    console.log(`demo-produce: usage ${JSON.stringify(out.produced.usage)} models ${JSON.stringify({ extraction: out.produced.extraction_models, embedding: out.produced.embedding_models, dimensions: out.produced.embedding_dimensions })}`);
  } finally {
    globalThis.fetch = realFetch;
    await dropAccount(fx);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`demo-produce: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(endPool);
