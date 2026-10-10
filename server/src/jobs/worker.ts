// The jobs worker (SAA-227 parts D and E): takes the work POST /captures queued
// and does it in this process. Extraction and its embeddings today.
//
// What it promises:
//   - One job at a time.
//   - No timer polls the table, and nothing listens for notifications; either
//     would keep Neon awake. It runs when woken (a capture was stored), once at
//     boot (start(): one SELECT), and from a one-shot timer set only when the
//     table says there is something to wait for: a retry's backoff, or the lease
//     of a job a dead process left running. After a database error a timer is
//     set for errorRetryMs as well, so a job is not stranded by a blip.
//   - A job is claimed under a lease token and a lease of leaseMs, renewed every
//     renewMs while it runs. If the renewal finds the token gone (or cannot reach
//     the database for a whole lease), the job's signal is aborted and nothing
//     more is written for it. Promotion is fenced on the same token
//     (extract.ts promoteRecording), so a worker that was too slow to notice still
//     cannot promote.
//   - attempts counts claims. It is given back when an attempt ends through no
//     fault of the work: shutdown, and a missing ANTHROPIC_API_KEY. A lost lease
//     writes nothing, so there is nothing to give back; the new claim counted
//     itself. A process killed outright keeps its attempt: that is how a job that
//     crashes the process stops after maxAttempts.
//   - A failure is retried after backoffMs[attempts - 1] and after maxAttempts
//     the job is failed. An abort is never a failure, whatever error it surfaced
//     as (see abort.ts).
//   - Extraction is done once: a job whose recording is already complete does not
//     call Anthropic (a re_extract does, when the names have changed since the
//     promoted run was built). Each run's id is recorded on the job before it
//     writes a row; the next attempt deletes the unpromoted rows of the runs a
//     killed attempt left. After extraction, any current-run moment without an
//     embedding is embedded before the job is marked done; if some stay unembedded
//     the attempt fails.
//   - Nothing of a call is ever written to a log or to the job row: ids, counts,
//     the error's class, and lib/safe-error's one-line description of it.

import Anthropic from "@anthropic-ai/sdk";
import type { QueryResult, QueryResultRow } from "pg";
import { pool } from "../db/index.js";
import { readExtractionCompletion, runExtraction, speakerFingerprintHash, LeaseLostError } from "../extract/extract.js";
import { embedMomentsByIds, type Embedder } from "../extract/embeddings.js";
import { describeErrorLine, errorClassOf, logError } from "../lib/safe-error.js";
import { abortableFetch } from "./abort.js";
import type { Wakeable } from "./registry.js";

export type WorkerOptions = {
  leaseMs?: number;
  renewMs?: number;
  // Waits before a retry: after the first failed attempt, after the second, ...
  backoffMs?: number[];
  maxAttempts?: number;
  // After a database error in the worker loop or the boot check: the wait before
  // trying again, doubling for each consecutive error up to errorRetryMaxMs, and
  // back to the first on any pass that succeeds.
  errorRetryMs?: number;
  errorRetryMaxMs?: number;
  // The database call every query goes through; absent, the pool. A check passes
  // one that fails and counts.
  query?: Query;
  // The fetch under the Anthropic client, and the embedder. Absent: the real ones.
  anthropicFetch?: typeof fetch;
  embedder?: Embedder;
};

export type Query = <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<R>>;

type JobRow = {
  id: string;
  account_id: string;
  recording_id: string;
  kind: "extract" | "re_extract";
  attempts: number;
  lease_token: string;
  run_ids: string[];
};

type Running = { job: JobRow; ctl: AbortController; reason: "lease" | "shutdown" | null };

class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY not set");
    this.name = "MissingApiKeyError";
  }
}

class EmbeddingIncompleteError extends Error {
  constructor(count: number) {
    super(`${count} current-run moment(s) still have no embedding`);
    this.name = "EmbeddingIncompleteError";
  }
}

const NEXT_WORK_SQL = `
  select (extract(epoch from (min(t) - now())) * 1000)::float8 as ms from (
    select run_after as t from jobs where state = 'queued' and run_after > now()
    union all
    select lease_expires_at as t from jobs where state = 'running' and lease_expires_at >= now()
  ) s`;

export class JobWorker implements Wakeable {
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly backoffMs: number[];
  private readonly maxAttempts: number;
  private readonly errorRetryMs: number;
  private readonly errorRetryMaxMs: number;
  private readonly query: Query;
  private errorStreak = 0;
  private readonly anthropicFetch: typeof fetch;
  private readonly embedder: Embedder | undefined;

  private current: Running | null = null;
  private loop: Promise<void> | null = null;
  private again = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: WorkerOptions = {}) {
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.renewMs = opts.renewMs ?? 20_000;
    this.backoffMs = opts.backoffMs ?? [60_000, 300_000];
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.errorRetryMs = opts.errorRetryMs ?? 30_000;
    this.errorRetryMaxMs = opts.errorRetryMaxMs ?? 3_600_000;
    this.query = opts.query ?? ((text, params) => pool.query(text, params));
    this.anthropicFetch = opts.anthropicFetch ?? ((input, init) => fetch(input, init));
    this.embedder = opts.embedder;
  }

  // Once, at boot, from the listen callback and not awaited by it. One SELECT: is
  // anything runnable now, and if not, when is the next thing.
  async start(): Promise<void> {
    try {
      const r = await this.query<{ runnable: boolean; ms: number | null }>(
        `select exists (
           select 1 from jobs
           where (state = 'queued' and run_after <= now()) or (state = 'running' and lease_expires_at < now())
         ) as runnable,
         (${NEXT_WORK_SQL}) as ms`,
      );
      const { runnable, ms } = r.rows[0];
      this.errorStreak = 0;
      if (runnable) this.wake();
      else if (ms !== null) this.arm(ms);
    } catch (err) {
      logError("jobs: boot check failed", err);
      this.armAfterError();
    }
  }

  wake(): void {
    if (this.stopping) return;
    this.clearTimer();
    void this.run();
  }

  // Resolves when the pass in progress, if any, has finished. For checks.
  whenIdle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  // Aborts the job in flight, gives it back to the queue without an attempt, and
  // resolves when the worker is idle. For SIGTERM (server.ts).
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    if (this.current) {
      this.current.reason ??= "shutdown";
      this.current.ctl.abort();
    }
    await this.loop;
  }

  private run(): Promise<void> {
    if (this.loop) {
      this.again = true;
      return this.loop;
    }
    this.loop = this.drain().finally(() => {
      this.loop = null;
    });
    return this.loop;
  }

  private async drain(): Promise<void> {
    try {
      await this.pass();
      this.errorStreak = 0;
    } catch (err) {
      logError("jobs: worker loop failed", err);
      if (!this.stopping) this.armAfterError();
    }
  }

  // Waits errorRetryMs after the first error, twice that after the second, and so
  // on up to errorRetryMaxMs, so a database that stays down is asked once per step
  // and not once per timer.
  private armAfterError(): void {
    const wait = Math.min(this.errorRetryMs * 2 ** this.errorStreak, this.errorRetryMaxMs);
    this.errorStreak++;
    console.log(`jobs: database error ${this.errorStreak} in a row; trying again in ${Math.round(wait / 1000)} s`);
    this.arm(wait);
  }

  // Claims and runs jobs until none is runnable, then sets the one-shot timer if
  // the table says something is due later. A wake that arrives while this runs
  // (this.again) is not lost: the loop goes round again.
  private async pass(): Promise<void> {
    for (;;) {
      this.again = false;
      while (!this.stopping) {
        const job = await this.claim();
        if (!job) break;
        await this.process(job);
      }
      if (this.stopping) return;
      const next = await this.query<{ ms: number | null }>(NEXT_WORK_SQL);
      if (this.again) continue;
      const ms = next.rows[0].ms;
      if (ms !== null) this.arm(ms);
      return;
    }
  }

  private arm(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, Math.max(0, ms) + 25);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // The oldest runnable job, claimed: queued and due, or running with a lease
  // that ran out (its worker died). A running job that has used all its attempts
  // is failed here instead of being claimed again.
  private async claim(): Promise<JobRow | null> {
    const exhausted = await this.query<{ id: string; recording_id: string; kind: string }>(
      `update jobs set state = 'failed', finished_at = now(), updated_at = now(), lease_token = null, lease_expires_at = null,
              error_class = 'LeaseExpired', last_error = 'the lease ran out on the last attempt'
       where state = 'running' and lease_expires_at < now() and attempts >= $1
       returning id, recording_id, kind`,
      [this.maxAttempts],
    );
    for (const j of exhausted.rows) this.log(j.id, j.recording_id, j.kind, "running→failed", "lease ran out on the last attempt");
    const r = await this.query<JobRow>(
      `update jobs set state = 'running', lease_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => $1::float8),
              attempts = attempts + 1, started_at = now(), updated_at = now()
       where id = (
         select id from jobs
         where (state = 'queued' and run_after <= now()) or (state = 'running' and lease_expires_at < now())
         order by created_at, id
         limit 1
         for update skip locked
       )
       returning id, account_id, recording_id, kind, attempts, lease_token, run_ids`,
      [this.leaseMs / 1000],
    );
    return r.rows[0] ?? null;
  }

  private async process(job: JobRow): Promise<void> {
    const cur: Running = { job, ctl: new AbortController(), reason: null };
    this.current = cur;
    this.log(job.id, job.recording_id, job.kind, "queued→running", `attempt ${job.attempts}`);
    let lastRenewed = Date.now();
    let renewing = false;
    const renew = setInterval(() => {
      if (renewing) return;
      renewing = true;
      this.query(
        `update jobs set lease_expires_at = now() + make_interval(secs => $3::float8), updated_at = now()
         where id = $1 and lease_token = $2 and state = 'running'`,
        [job.id, job.lease_token, this.leaseMs / 1000],
      )
        .then((r) => {
          if (this.current !== cur) return; // settled while this was in flight
          if (r.rowCount === 0) this.loseLease(cur, "the lease token is gone");
          else lastRenewed = Date.now();
        })
        .catch((err: unknown) => {
          logError(`jobs: ${job.id} lease renewal failed`, err);
          if (Date.now() - lastRenewed > this.leaseMs) this.loseLease(cur, "the lease could not be renewed for a whole lease");
        })
        .finally(() => {
          renewing = false;
        });
    }, this.renewMs);
    try {
      await this.execute(cur);
      await this.finish(cur, "done");
    } catch (err) {
      await this.settleFailure(cur, err);
    } finally {
      clearInterval(renew);
      this.current = null;
    }
  }

  private loseLease(cur: Running, why: string): void {
    if (cur.reason) return;
    cur.reason = "lease";
    this.log(cur.job.id, cur.job.recording_id, cur.job.kind, "lease lost", why);
    cur.ctl.abort();
  }

  // The work of one attempt.
  private async execute(cur: Running): Promise<void> {
    const { job, ctl } = cur;
    const signal = ctl.signal;
    const completion = await readExtractionCompletion(job.recording_id);
    if (!completion.exists) throw new Error("the recording does not exist");

    // Is there extraction to do? Not if the recording is already complete: a
    // resumed job must not call Anthropic again. A re_extract is the exception, and
    // only when the speaker names have changed since the promoted run was built.
    let needsRun = !completion.complete;
    if (completion.complete && job.kind === "re_extract") {
      const stored = await this.query<{ fp: string | null }>(
        `select metadata->>'extraction_speaker_fingerprint' as fp from recordings where id = $1`,
        [job.recording_id],
      );
      needsRun = stored.rows[0]?.fp !== (await speakerFingerprintHash(job.recording_id));
    }

    if (needsRun) {
      if (!process.env.ANTHROPIC_API_KEY) throw new MissingApiKeyError();
      signal.throwIfAborted();
      await this.deleteUnpromotedRows(job);
      const client = new Anthropic({ fetch: abortableFetch(this.anthropicFetch, signal) });
      await runExtraction(job.recording_id, {
        client,
        signal,
        embedder: this.embedder,
        leaseGuard: { jobId: job.id, leaseToken: job.lease_token },
        onRunStart: async (runUuid) => {
          const r = await this.query(
            `update jobs set run_ids = array_append(run_ids, $3::uuid), updated_at = now()
             where id = $1 and lease_token = $2 and state = 'running'`,
            [job.id, job.lease_token, runUuid],
          );
          if (r.rowCount === 0) throw new LeaseLostError();
        },
      });
    }

    signal.throwIfAborted();
    await this.embedMissing(job, signal);
    // A run that was redone inside runExtraction (names changed mid-run) left its
    // first run's rows unpromoted; they are this job's, and recorded.
    await this.deleteUnpromotedRows(job);
  }

  // Rows left by runs this job started and did not promote: a killed attempt's,
  // or the first run of a pair when runExtraction redid it. Only runs recorded on
  // the job row (read here, so a run recorded a moment ago counts), every moment of
  // them (collapsed ones included: collapse only ever points inside its own run),
  // and never the recording's current run. The one foreign key into moments is
  // clips.moment_id, ON DELETE SET NULL (check-jobs-table asserts that).
  private async deleteUnpromotedRows(job: JobRow): Promise<void> {
    const r = await this.query(
      `delete from moments m using recordings r, jobs j
       where j.id = $1 and r.id = m.recording_id and m.recording_id = $2
         and (m.metadata->>'extraction_run') in (select x::text from unnest(j.run_ids) x)
         and (m.metadata->>'extraction_run') is distinct from (r.metadata->>'current_extraction_run')`,
      [job.id, job.recording_id],
    );
    if (r.rowCount) console.log(`jobs: ${job.id} recording=${job.recording_id} removed ${r.rowCount} unpromoted moment(s)`);
  }

  // The current run's visible moments that have text and no embedding.
  private async missingEmbeddings(recordingId: string): Promise<string[]> {
    const r = await this.query<{ id: string }>(
      `select m.id from moments m join recordings r on r.id = m.recording_id
       where m.recording_id = $1
         and (m.metadata->>'extraction_run') = (r.metadata->>'current_extraction_run')
         and (m.metadata->>'collapsed_into') is null
         and m.embedding is null
         and (btrim(coalesce(m.title, '')) <> '' or btrim(coalesce(m.summary, '')) <> '')`,
      [recordingId],
    );
    return r.rows.map((x) => x.id);
  }

  private async embedMissing(job: JobRow, signal: AbortSignal): Promise<void> {
    const ids = await this.missingEmbeddings(job.recording_id);
    if (ids.length === 0) return;
    console.log(`jobs: ${job.id} recording=${job.recording_id} embedding ${ids.length} moment(s) left without one`);
    await embedMomentsByIds(ids, { embedder: this.embedder, signal });
    const left = await this.missingEmbeddings(job.recording_id);
    if (left.length > 0) throw new EmbeddingIncompleteError(left.length);
  }

  // running → done. Conditioned on the lease token like every write the job makes.
  private async finish(cur: Running, to: "done"): Promise<void> {
    const { job } = cur;
    const r = await this.query(
      `update jobs set state = $3, finished_at = now(), updated_at = now(), lease_token = null, lease_expires_at = null,
              error_class = null, last_error = null
       where id = $1 and lease_token = $2 and state = 'running'`,
      [job.id, job.lease_token, to],
    );
    if (r.rowCount === 0) this.log(job.id, job.recording_id, job.kind, "lease lost", "could not mark it done");
    else this.log(job.id, job.recording_id, job.kind, "running→done");
  }

  // The attempt threw. An abort is not a failure: whatever the error looked like,
  // if the worker aborted the job (lease lost, shutdown) it is handled as that.
  private async settleFailure(cur: Running, err: unknown): Promise<void> {
    const { job } = cur;
    if (cur.reason === "lease" || err instanceof LeaseLostError) {
      this.log(job.id, job.recording_id, job.kind, "stood down", "the lease was lost; nothing written");
      return;
    }
    if (cur.reason === "shutdown") {
      const r = await this.query(
        `update jobs set state = 'queued', attempts = attempts - 1, run_after = now(), lease_token = null, lease_expires_at = null, updated_at = now()
         where id = $1 and lease_token = $2 and state = 'running'`,
        [job.id, job.lease_token],
      );
      this.log(job.id, job.recording_id, job.kind, r.rowCount === 0 ? "lease lost" : "running→queued", "shutdown; the attempt is not counted");
      return;
    }

    const errorClass = errorClassOf(err);
    const line = describeErrorLine(err).slice(0, 500);
    if (err instanceof MissingApiKeyError) {
      const r = await this.query(
        `update jobs set state = 'failed', attempts = attempts - 1, finished_at = now(), updated_at = now(), lease_token = null, lease_expires_at = null,
                error_class = $3, last_error = $4
         where id = $1 and lease_token = $2 and state = 'running'`,
        [job.id, job.lease_token, errorClass, line],
      );
      this.log(job.id, job.recording_id, job.kind, r.rowCount === 0 ? "lease lost" : "running→failed", `${line}; the attempt is not counted`);
      return;
    }
    if (job.attempts >= this.maxAttempts) {
      const r = await this.query(
        `update jobs set state = 'failed', finished_at = now(), updated_at = now(), lease_token = null, lease_expires_at = null,
                error_class = $3, last_error = $4
         where id = $1 and lease_token = $2 and state = 'running'`,
        [job.id, job.lease_token, errorClass, line],
      );
      this.log(job.id, job.recording_id, job.kind, r.rowCount === 0 ? "lease lost" : "running→failed", `${line}; attempt ${job.attempts} of ${this.maxAttempts}`);
      return;
    }
    const wait = this.backoffMs[Math.min(job.attempts - 1, this.backoffMs.length - 1)] ?? 0;
    const r = await this.query(
      `update jobs set state = 'queued', run_after = now() + make_interval(secs => $5::float8), updated_at = now(), lease_token = null, lease_expires_at = null,
              error_class = $3, last_error = $4
       where id = $1 and lease_token = $2 and state = 'running'`,
      [job.id, job.lease_token, errorClass, line, wait / 1000],
    );
    this.log(job.id, job.recording_id, job.kind, r.rowCount === 0 ? "lease lost" : "running→queued", `${line}; attempt ${job.attempts} of ${this.maxAttempts}, retry in ${Math.round(wait / 1000)} s`);
  }

  // One line per state change, ids and words of ours only.
  private log(jobId: string, recordingId: string, kind: string, change: string, note?: string): void {
    console.log(`jobs: ${jobId} recording=${recordingId} kind=${kind} ${change}${note ? ` (${note})` : ""}`);
  }
}
