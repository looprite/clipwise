// Check for the call-text backfill, db/encrypt-call-text.ts (SAA-277 step 6).
//
// Plants plain call text with raw SQL, as rows written before step 2 hold it, in
// every column and metadata field the schema seals, plus one value already
// encrypted. Then:
//   - the dry run counts them and writes nothing;
//   - --apply is refused without CALL_TEXT_KEY_ID, and with one that names another
//     key, and when a value is already encrypted under another key id; each
//     refusal writes nothing, and names key ids, never a value;
//   - control: with the key's own id and one key in the database, --apply runs:
//     in batches, keeping a row the server changes mid-batch (it is read again,
//     not written over), leaving the value already encrypted as it was, and
//     ending with the readback at 0 everywhere;
//   - decrypting gives back every original, and the metadata keys searches
//     filter on are untouched;
//   - a second --apply writes nothing;
//   - the planted phrase is in no line the backfill or anything else printed.
//
// Writes, so it refuses unless run through scratch-db.sh on a scratch branch:
//
//   scripts/scratch-db.sh run check-encrypt-backfill
//
// The backfill runs over the whole scratch database, as it will on main: rows
// other checks left in plain are encrypted too.

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { encryptCallText, loadCallTextKey } from "../lib/call-text.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { BackfillRefused, ENCRYPTED_RE, TARGETS, backfill, type Target } from "./encrypt-call-text.js";
import { db, pool, schema } from "./index.js";

const written: string[] = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
const tap = (chunk: unknown) => {
  for (const line of String(chunk).split("\n")) if (line !== "") written.push(line);
};
process.stdout.write = ((chunk: unknown) => (tap(chunk), true)) as typeof process.stdout.write;
process.stderr.write = ((chunk: unknown) => (tap(chunk), (realErr as (c: unknown) => boolean)(chunk))) as typeof process.stderr.write;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  realOut(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}\n`);
  if (!ok) failures++;
}
const show = (line: string) => realOut(`  ${line}\n`);
// Equal as JSON values: Postgres stores jsonb with its keys reordered, so key
// order is not compared.
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

await refuseUnlessScratch("check-encrypt-backfill");
const key = loadCallTextKey({ CALL_TEXT_KEY: process.env.CALL_TEXT_KEY });
const otherKey = loadCallTextKey({ CALL_TEXT_KEY: randomBytes(32).toString("base64") });

let fx: Fixture | null = null;
try {
  fx = await makeAccount("check-encrypt-backfill");
  const P = `quokka${fx.tag}harbor`;
  const R = randomUUID();
  const RUN = randomUUID();

  // ---- plain rows, written as the old schema wrote them ----
  const recordingMeta = {
    current_extraction_run: RUN,
    capture: { stem: "2026-11-08-1100" },
    capture_quality: { verdict: "partial", dropped_segments: [{ track: "them", start_ms: 0, end_ms: 900, text: `dropped ${P} line` }] },
    identity: { guests: [{ name: "Guest Name" }] },
  };
  await pool.query(
    `insert into recordings (id, account_id, owner_member_id, slug, title, source, source_id, status, visibility, metadata)
     values ($1, $2, $3, $4, $5, 'check', $7, 'ready', 'private', $6::jsonb)`,
    [R, fx.accountId, fx.memberId, `check-encrypt-backfill-${fx.tag}`, `Plan review ${P}`, JSON.stringify(recordingMeta), R],
  );
  const T = (await pool.query(`insert into transcripts (recording_id, provider, text, status) values ($1, 'check', $2, 'ready') returning id`, [R, `whole ${P} transcript`])).rows[0].id as string;
  const S = (await pool.query(`insert into speakers (recording_id, label) values ($1, 'me') returning id`, [R])).rows[0].id as string;
  const segTexts = [0, 1, 2, 3, 4].map((i) => `segment ${i} on the ${P} plan`);
  for (const [i, text] of segTexts.entries()) {
    await pool.query(
      `insert into segments (account_id, recording_id, transcript_id, speaker_id, start_sec, end_sec, text, order_index) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [fx.accountId, R, T, S, i * 5, i * 5 + 4, text, i],
    );
  }
  const momentMeta = (i: number) => ({ source: "extracted", extraction_run: RUN, span_label: `${P} topic ${i}`, speakers: [`Guest ${P}`, "them"], span_segment_range: [i, i + 1] });
  const momentIds: string[] = [];
  for (const i of [0, 1, 2]) {
    momentIds.push(
      (await pool.query(
        `insert into moments (account_id, recording_id, kind, title, summary, start_sec, end_sec, metadata) values ($1, $2, 'decision', $3, $4, $5, $6, $7::jsonb) returning id`,
        [fx.accountId, R, `${P} point ${i}`, `about the ${P} plan, part ${i}`, i, i + 1, JSON.stringify(momentMeta(i))],
      )).rows[0].id as string,
    );
  }
  await pool.query(`insert into clips (account_id, recording_id, title, description, start_sec, end_sec) values ($1, $2, $3, $4, 0, 4)`, [fx.accountId, R, `clip ${P}`, `about ${P}`]);
  // One value already encrypted (written through the ORM): it must be left as it is.
  const [already] = await db
    .insert(schema.segments)
    .values({ accountId: fx.accountId, recordingId: R, transcriptId: T, speakerId: S, startSec: 30, endSec: 34, text: `already encrypted ${P}`, orderIndex: 5 })
    .returning({ id: schema.segments.id });
  const alreadyStored = (await pool.query(`select text from segments where id = $1`, [already.id])).rows[0].text as string;

  // This recording's rows, per target, that are plain.
  const own = (t: Target) => (t.table === "recordings" ? "id = $2" : "recording_id = $2");
  const ownPlain = async () => {
    const out: Record<string, number> = {};
    for (const t of TARGETS) out[t.label] = (await pool.query(`select count(*)::int n from ${t.table} where (${t.plain}) and ${own(t)}`, [ENCRYPTED_RE, R])).rows[0].n;
    return out;
  };
  const expected: Record<string, number> = {
    "recordings.title": 1,
    "transcripts.text": 1,
    "segments.text": 5,
    "moments.title": 3,
    "moments.summary": 3,
    "clips.title": 1,
    "clips.description": 1,
    "moments.metadata (span_label, speakers)": 3,
    "recordings.metadata (dropped_segments text)": 1,
  };
  const N = Object.values(expected).reduce((a, b) => a + b, 0);
  const before = await ownPlain();
  show(`plain values planted, per target: ${JSON.stringify(before)}`);
  check(`setup: ${N} plain values planted, every target covered`, JSON.stringify(before) === JSON.stringify(expected), JSON.stringify(before));
  check("setup: the value written through the ORM is already encrypted", new RegExp(ENCRYPTED_RE).test(alreadyStored));

  const lines: string[] = [];
  const log = (l: string) => {
    lines.push(l);
    show(l);
  };

  // ---- dry run ----
  const dry = await backfill(pool, { apply: false, key, log });
  check("dry run: it counts at least the planted values in every target", dry.results.every((r) => r.plainBefore >= expected[r.label]), JSON.stringify(dry.results.map((r) => [r.label, r.plainBefore])));
  check("dry run: it writes nothing", JSON.stringify(await ownPlain()) === JSON.stringify(expected));

  // ---- the refusals, each writing nothing ----
  const refusal = async (opts: Parameters<typeof backfill>[1]) => {
    try {
      await backfill(pool, opts);
      return null;
    } catch (err) {
      if (err instanceof BackfillRefused) return err.message;
      throw err;
    }
  };
  const noId = await refusal({ apply: true, key, expectedKeyId: undefined, log });
  check("--apply without CALL_TEXT_KEY_ID is refused, naming the variable", noId !== null && noId.includes("CALL_TEXT_KEY_ID is not set"), String(noId));
  check("  and writes nothing", JSON.stringify(await ownPlain()) === JSON.stringify(expected));
  const wrongId = await refusal({ apply: true, key, expectedKeyId: otherKey.id, log });
  check("--apply with a CALL_TEXT_KEY_ID that is not the key's is refused, naming both ids", wrongId !== null && wrongId.includes(key.id) && wrongId.includes(otherKey.id), String(wrongId));
  check("  and writes nothing", JSON.stringify(await ownPlain()) === JSON.stringify(expected));

  const foreign = randomUUID();
  const foreignTitle = encryptCallText(`other key ${P}`, otherKey);
  await pool.query(`insert into clips (id, account_id, recording_id, title, start_sec, end_sec) values ($1, $2, $3, $4, 0, 1)`, [foreign, fx.accountId, R, foreignTitle]);
  const mixed = await refusal({ apply: true, key, expectedKeyId: key.id, log });
  check("--apply when a value is already encrypted under another key is refused, naming that key's id", mixed !== null && mixed.includes(otherKey.id), String(mixed));
  check("  the refusal names ids only: no value, no key", mixed !== null && !mixed.includes(foreignTitle) && !mixed.includes(P) && !mixed.includes(key.bytes.toString("base64")));
  check("  and writes nothing", JSON.stringify(await ownPlain()) === JSON.stringify(expected));
  await pool.query(`delete from clips where id = $1`, [foreign]);

  // ---- control: the real run ----
  // Mid-batch, change one moment's title the way the server could (a plain value
  // the backfill did not read): that row must be read again, not written over.
  let changed: string | null = null;
  const run = await backfill(pool, {
    apply: true,
    key,
    expectedKeyId: key.id,
    batchSize: 2,
    log,
    beforeUpdate: async (t, ids) => {
      if (changed === null && t.label === "moments.title" && ids.includes(momentIds[0])) {
        changed = momentIds[0];
        await pool.query(`update moments set title = $2 where id = $1`, [momentIds[0], `changed mid-batch ${P}`]);
      }
    },
  });
  const after = await ownPlain();
  check("control: with the key's own id and one key in the database, --apply runs", run.results.length === TARGETS.length);
  check(`after --apply: 0 of the ${N} planted values are plain`, Object.values(after).every((n) => n === 0), JSON.stringify(after));
  check("after --apply: the readback is 0 in every target, database-wide", run.readback.every((r) => r.plain === 0), JSON.stringify(run.readback));
  check("it worked in batches (segments took more than one)", (run.results.find((r) => r.label === "segments.text")?.batches ?? 0) > 1, JSON.stringify(run.results.find((r) => r.label === "segments.text")));
  const mt = run.results.find((r) => r.label === "moments.title")!;
  check("the row changed mid-batch was counted as a conflict and read again in a second sweep", changed !== null && mt.conflicts === 1 && mt.sweeps >= 2, JSON.stringify(mt));
  const [m0] = await db.select({ title: schema.moments.title }).from(schema.moments).where(eq(schema.moments.id, momentIds[0]));
  check("  and it holds the server's change, encrypted: the backfill did not write over it", m0.title === `changed mid-batch ${P}`, `title length ${m0.title?.length ?? "null"}`);
  const alreadyAfter = (await pool.query(`select text from segments where id = $1`, [already.id])).rows[0].text as string;
  check("the value already encrypted was left exactly as it was", alreadyAfter === alreadyStored);

  // ---- decrypting gives the originals ----
  const [rec] = await db.select({ title: schema.recordings.title, metadata: schema.recordings.metadata }).from(schema.recordings).where(eq(schema.recordings.id, R));
  check("recording title decrypts to the original", rec.title === `Plan review ${P}`, `title length ${rec.title?.length ?? "null"}`);
  check("recording metadata opens to the original (dropped text, identity and the rest)", sameJson(rec.metadata, recordingMeta), `keys: ${Object.keys((rec.metadata as object) ?? {}).sort().join(",")}`);
  const [tr] = await db.select({ text: schema.transcripts.text }).from(schema.transcripts).where(eq(schema.transcripts.id, T));
  check("transcript text decrypts to the original", tr.text === `whole ${P} transcript`);
  const segs = await db.select({ text: schema.segments.text, i: schema.segments.orderIndex }).from(schema.segments).where(eq(schema.segments.recordingId, R));
  check("every segment decrypts to the original", segTexts.every((t, i) => segs.find((s) => s.i === i)?.text === t) && segs.find((s) => s.i === 5)?.text === `already encrypted ${P}`);
  const moms = await db.select({ id: schema.moments.id, title: schema.moments.title, summary: schema.moments.summary, metadata: schema.moments.metadata }).from(schema.moments).where(eq(schema.moments.recordingId, R));
  const momentsOk = [1, 2].every((i) => {
    const m = moms.find((x) => x.id === momentIds[i]);
    return m?.title === `${P} point ${i}` && m.summary === `about the ${P} plan, part ${i}` && sameJson(m.metadata, momentMeta(i));
  });
  check("moment titles, summaries and metadata (span_label, speakers) open to the originals", momentsOk && sameJson(moms.find((x) => x.id === momentIds[0])?.metadata, momentMeta(0)));
  check("control: the comparison notices a changed value", !sameJson({ ...momentMeta(0), span_label: "x" }, momentMeta(0)));
  const structural = (await pool.query(`select count(*)::int n from moments where recording_id = $1 and metadata->>'source' = 'extracted' and metadata->>'extraction_run' = $2`, [R, RUN])).rows[0].n;
  check("the moment keys searches filter on are still plain in SQL", structural === 3, String(structural));
  const [clip] = await db.select({ title: schema.clips.title, description: schema.clips.description }).from(schema.clips).where(eq(schema.clips.recordingId, R));
  check("clip title and description decrypt to the originals", clip.title === `clip ${P}` && clip.description === `about ${P}`);

  // ---- a second run writes nothing ----
  const snapshot = async () =>
    JSON.stringify([
      (await pool.query(`select title, metadata::text m from recordings where id = $1`, [R])).rows,
      (await pool.query(`select text from transcripts where recording_id = $1`, [R])).rows,
      (await pool.query(`select text from segments where recording_id = $1 order by order_index`, [R])).rows,
      (await pool.query(`select title, summary, metadata::text m from moments where recording_id = $1 order by id`, [R])).rows,
      (await pool.query(`select title, description from clips where recording_id = $1 order by id`, [R])).rows,
    ]);
  const snap1 = await snapshot();
  const again = await backfill(pool, { apply: true, key, expectedKeyId: key.id, log });
  check("a second --apply finds nothing plain and encrypts nothing", again.results.every((r) => r.plainBefore === 0 && r.encrypted === 0), JSON.stringify(again.results.map((r) => [r.label, r.plainBefore, r.encrypted])));
  check("  and every stored value is byte for byte what the first run left", (await snapshot()) === snap1);

  // ---- nothing of the call in any output ----
  const all = [...lines, ...written];
  const leaked = all.filter((l) => l.includes(P) || l.includes("quokka"));
  check("the planted phrase is in no line the backfill or anything else printed", leaked.length === 0, leaked.slice(0, 3).join(" / "));
  check("control: the containment test would see it", `x ${P} x`.includes(P));
  const ok = /^(backfill|readback): [A-Za-z0-9 ,.=():_\-]+$/;
  const odd = lines.filter((l) => !ok.test(l));
  check("every backfill line is counts, labels and ids only", lines.length > 0 && odd.length === 0, odd.slice(0, 3).join(" / "));
} finally {
  if (fx) await dropAccount(fx);
  await endPool();
}

realOut(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
