// Recovery for the database-free capture pipeline (SAA-227 decision 10). Driven by
// files only: it finishes the captures whose capture-pipeline record
// (pipeline-<stem>.json with `pipeline: "capture"`, capture-cli.ts) shows a run
// that did not finish, by running that pipeline again. recover.ts, which decides
// from the database, is unchanged and still serves the direct pipeline.
//
// A capture is finished again when its record has a step that is not ok or
// skipped, and no live process is working on it: a step left `running` by a
// process that has gone (killed mid-step) counts, one whose process is alive
// does not. Not retried: a capture in the trash, and one the classifier refused
// (classify failed), which a second run would refuse the same way. Only captures
// with a capture-pipeline record are looked at, never every capture on disk.
//
// For each capture it ran, it writes recovery-<stem>.json as recover.ts does
// (attempts, last_action "recovered" or "failed", last_action_at), which is what
// the recorder reads to queue a recovered capture for upload (main.js
// queueRecoveredCaptures). It loads no database code and needs no API key.
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

type Attempts = {
  stem: string;
  recording_id: string;
  attempts: number;
  last_error: string | null;
  last_action: "recovered" | "failed" | null;
  last_action_at: string | null;
};

function readAttempts(dir: string, stem: string, recordingId: string): Attempts {
  try {
    const prior = JSON.parse(readFileSync(join(dir, `recovery-${stem}.json`), "utf8")) as Attempts;
    if (prior.recording_id === recordingId) return prior;
  } catch {}
  return { stem, recording_id: recordingId, attempts: 0, last_error: null, last_action: null, last_action_at: null };
}

// The stems this pass should finish, with why.
export function unfinishedCaptures(dir: string): Array<{ stem: string; why: string }> {
  const out: Array<{ stem: string; why: string }> = [];
  for (const name of readdirSync(dir)) {
    const m = /^pipeline-(.+)\.json$/.exec(name);
    if (!m) continue;
    const stem = m[1];
    let doc: CaptureSidecar;
    try {
      doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (doc.pipeline !== "capture" || !doc.steps) continue;
    if (!existsSync(join(dir, `manifest-${stem}.json`)) || isTrashed(dir, stem)) continue;
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
    log(`${stem}: finishing (${why})`);
    const recordingId = (JSON.parse(readFileSync(join(dir, `manifest-${stem}.json`), "utf8")) as { recording_id: string }).recording_id;
    const a = readAttempts(dir, stem, recordingId);
    a.attempts += 1;
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
