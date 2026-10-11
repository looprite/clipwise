// Recovery for the database-free capture pipeline (SAA-227 decision 10). Driven by
// files only: it finishes the captures whose capture-pipeline record
// (pipeline-<stem>.json with `pipeline: "capture"`, capture-cli.ts) shows a run
// that did not finish, by running that pipeline again. recover.ts, which decides
// from the database, is unchanged and still serves the direct pipeline.
//
// A capture is finished again when its record has a step that is not ok or
// skipped, and no live process is working on it: a step left `running` by a
// process that has gone (killed mid-step) counts, one whose process is alive
// does not. A capture with a manifest and no pipeline record at all (the app
// went before its pipeline started) is run too, as recover.ts runs one with no
// recording row (SAA-227 part L decision 10). Not retried: a capture in the
// trash, and one the classifier refused (classify failed), which a second run
// would refuse the same way. A record the direct pipeline wrote (no
// `pipeline: "capture"`) is left alone: only one mode runs at a time.
//
// The same budget as recover.ts (decision 9): at most 3 attempts per capture,
// at least 10 minutes apart, the attempt written before the run so that a
// process killed mid-run still counts it.
//
// For each capture it looked at, it writes recovery-<stem>.json as recover.ts
// does (attempts, last_action, last_action_at), which is what the recorder reads
// to queue a recovered capture for upload (main.js queueRecoveredCaptures, on
// "recovered" only). It loads no database code and needs no API key.
//
// Usage:
//   tsx src/pipeline/capture-recover.ts <capture_dir>

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isTrashed } from "../lib/trash-marker.js";
import { runCapturePipelineWithoutDatabase, type CaptureSidecar } from "./capture-cli.js";

function log(msg: string): void {
  process.stdout.write(`capture-recover: ${msg}\n`);
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// recover.ts's budget (DEFAULT_MAX_ATTEMPTS, RETRY_COOLDOWN_MS), with its reasons.
const MAX_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

type Attempts = {
  stem: string;
  recording_id: string;
  attempts: number;
  first_attempt_at?: string | null;
  last_attempt_at?: string | null;
  last_error: string | null;
  last_action: "recovered" | "failed" | "budget_exhausted" | "cooling_down" | null;
  last_action_at: string | null;
};

function readAttempts(dir: string, stem: string, recordingId: string): Attempts {
  try {
    const prior = JSON.parse(readFileSync(join(dir, `recovery-${stem}.json`), "utf8")) as Attempts;
    if (prior.recording_id === recordingId && typeof prior.attempts === "number") return prior;
  } catch {}
  return { stem, recording_id: recordingId, attempts: 0, first_attempt_at: null, last_attempt_at: null, last_error: null, last_action: null, last_action_at: null };
}

// The stems this pass should finish, with why.
export function unfinishedCaptures(dir: string): Array<{ stem: string; why: string }> {
  const out: Array<{ stem: string; why: string }> = [];
  for (const name of readdirSync(dir)) {
    const m = /^manifest-(.+)\.json$/.exec(name);
    if (!m) continue;
    const stem = m[1];
    if (isTrashed(dir, stem)) continue;
    const recordPath = join(dir, `pipeline-${stem}.json`);
    if (!existsSync(recordPath)) {
      out.push({ stem, why: "never started" });
      continue;
    }
    let doc: CaptureSidecar;
    try {
      doc = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      continue;
    }
    if (doc.pipeline !== "capture" || !doc.steps) continue;
    const steps = Object.entries(doc.steps);
    if (steps.every(([, s]) => s.state === "ok" || s.state === "skipped")) continue;
    if (doc.steps.classify?.state === "failed") continue;
    if (steps.some(([, s]) => s.state === "running") && alive(doc.pid)) continue;
    const at = steps.find(([, s]) => s.state !== "ok" && s.state !== "skipped");
    out.push({ stem, why: `${at?.[0]} ${at?.[1].state}` });
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem));
}

async function main(): Promise<void> {
  const dirArg = process.argv[2];
  if (!dirArg) {
    process.stderr.write("usage: tsx src/pipeline/capture-recover.ts <capture_dir>\n");
    process.exit(2);
  }
  const dir = resolve(dirArg);
  const todo = unfinishedCaptures(dir);
  log(`${todo.length} unfinished capture(s)`);
  for (const { stem, why } of todo) {
    let recordingId: string | undefined;
    try {
      recordingId = (JSON.parse(readFileSync(join(dir, `manifest-${stem}.json`), "utf8")) as { recording_id?: string }).recording_id;
    } catch {
      log(`${stem}: manifest unreadable — skipping`);
      continue;
    }
    if (!recordingId) {
      log(`${stem}: manifest has no recording_id — skipping`);
      continue;
    }
    const a = readAttempts(dir, stem, recordingId);
    const held = (action: "budget_exhausted" | "cooling_down", detail: string): void => {
      log(`${stem}: ${action.replace("_", " ")} (${why}) — ${detail}`);
      a.last_action = action;
      a.last_action_at = new Date().toISOString();
      writeFileSync(join(dir, `recovery-${stem}.json`), JSON.stringify(a, null, 2) + "\n");
    };
    if (a.attempts >= MAX_ATTEMPTS) {
      held("budget_exhausted", `${a.attempts}/${MAX_ATTEMPTS} attempts used; last error: ${a.last_error ?? "none recorded"}`);
      continue;
    }
    const sinceLast = a.last_attempt_at ? Date.now() - Date.parse(a.last_attempt_at) : Infinity;
    if (Number.isFinite(sinceLast) && sinceLast >= 0 && sinceLast < RETRY_COOLDOWN_MS) {
      held("cooling_down", `attempted ${Math.round(sinceLast / 1000)}s ago (${a.attempts}/${MAX_ATTEMPTS} used)`);
      continue;
    }
    log(`${stem}: finishing (${why})`);
    const startedAt = new Date().toISOString();
    a.attempts += 1;
    a.first_attempt_at = a.first_attempt_at ?? startedAt;
    a.last_attempt_at = startedAt;
    // Written before the run, as recover.ts does: a process killed mid-run must
    // still have used the attempt.
    writeFileSync(join(dir, `recovery-${stem}.json`), JSON.stringify(a, null, 2) + "\n");
    try {
      await runCapturePipelineWithoutDatabase(dir, stem);
      a.last_action = "recovered";
      a.last_error = null;
      log(`${stem}: recovered`);
    } catch (err) {
      a.last_action = "failed";
      a.last_error = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log(`${stem}: failed — ${a.last_error}`);
      process.exitCode = 1;
    }
    a.last_action_at = new Date().toISOString();
    writeFileSync(join(dir, `recovery-${stem}.json`), JSON.stringify(a, null, 2) + "\n");
  }
}

if (process.argv[1] && process.argv[1].endsWith("capture-recover.ts")) {
  main().catch((err) => {
    process.stderr.write(`capture-recover: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
    process.exitCode = 1;
  });
}
