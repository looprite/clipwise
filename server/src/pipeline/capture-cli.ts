// The database-free capture pipeline (SAA-227 decision 8), beside the direct one
// (cli.ts → run-capture.ts). It does on the Mac only what needs the Mac: transcribe
// (transcribe.py, which starts diarize early), classify, the diarize sidecar, and
// the naming data. Ingest, the split and extraction are the server's, after the
// recorder uploads the capture (main.js builds the body from what this leaves).
//
// It loads no database code and needs no API key: nothing it imports reaches
// db/index.ts, which refuses to load without DATABASE_URL.
//
// pipeline-<stem>.json records three steps, transcribe, classify and diarize, and
// `pipeline: "capture"`, so it is never mistaken for the direct pipeline's record.
//
// Usage:
//   tsx src/pipeline/capture-cli.ts <capture_dir> --stem <stem>

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyCapture, type CaptureClassification, type TranscriptContent } from "./classify-capture.js";
import { generateVoiceNamingData, sidecarForCapture, type DiarizeSidecar } from "./voice-clips.js";

type StepName = "transcribe" | "classify" | "diarize";
type StepRecord = {
  state: "pending" | "running" | "ok" | "skipped" | "failed";
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  detail: Record<string, unknown> | null;
};
export type CaptureSidecar = {
  sidecar_version: number;
  pipeline: "capture";
  recording_id: string;
  stem: string;
  capture_dir: string;
  updated_at: string;
  pid: number | null;
  steps: Record<StepName, StepRecord>;
};

const REPO = resolve(import.meta.dirname, "..", "..", "..");

// What this runs, and from where. Run from a checkout, every default below is the
// checkout's own. Clipwise.app sets each one to its copy inside the bundle
// (SAA-198), so nothing is read from a checkout or found on PATH. The names past
// CLIPWISE_* are the ones transcribe.py reads for the same files (its Environment
// list), and voice-clips.ts reads FFMPEG_BIN; the values here are passed to
// transcribe.py, so the two never disagree. This log shows what was passed; each
// tool's own "tools:" line shows what ran.
const PYTHON = process.env.CLIPWISE_PYTHON ?? "python3";
const TRANSCRIBE_PY = process.env.CLIPWISE_TRANSCRIBE_PY ?? join(REPO, "recorder", "transcribe.py");
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const PARAKEET_BIN = process.env.PARAKEET_BIN ?? join(REPO, "recorder", "parakeet", ".build", "release", "parakeet");
const PARAKEET_MODELS = process.env.PARAKEET_MODELS ?? join(REPO, "recorder", "parakeet", "models");
const AEC_BIN = process.env.AEC_BIN ?? join(REPO, "recorder", "aec", ".build", "release", "aec");
const DIARIZE_BIN = process.env.DIARIZE_BIN ?? join(REPO, "recorder", "diarize", ".build", "release", "diarize");
const DIARIZE_MODELS = process.env.DIARIZE_MODELS ?? join(REPO, "recorder", "diarize", "models");

// A bare name is looked up on PATH the way execFileSync will, so the log shows
// the file that runs, not just the name.
function onPath(cmd: string): string {
  if (cmd.includes("/")) return cmd;
  for (const d of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const p = join(d, cmd);
    if (existsSync(p)) return p;
  }
  return `${cmd} (not on PATH)`;
}

// Once per run: the full path of every tool this run uses (SAA-198).
function logTools(): void {
  const tools: Record<string, string> = {
    node: `${process.execPath} ${process.version}`,
    python: onPath(PYTHON),
    transcribe: TRANSCRIBE_PY,
    ffmpeg: onPath(FFMPEG_BIN),
    parakeet: PARAKEET_BIN,
    parakeet_models: PARAKEET_MODELS,
    aec: AEC_BIN,
    diarize: DIARIZE_BIN,
    diarize_models: DIARIZE_MODELS,
  };
  log(`tools: ${Object.entries(tools).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

const TOOL_ENV = {
  ...process.env,
  FFMPEG_BIN,
  PARAKEET_BIN,
  PARAKEET_MODELS,
  AEC_BIN,
  DIARIZE_BIN,
  DIARIZE_MODELS,
};

function log(msg: string): void {
  process.stdout.write(`capture-pipeline: ${msg}\n`);
}

const emptyStep = (): StepRecord => ({ state: "pending", started_at: null, ended_at: null, error: null, detail: null });

export async function runCapturePipelineWithoutDatabase(dir: string, stem: string): Promise<CaptureSidecar> {
  const manifest = JSON.parse(readFileSync(join(dir, `manifest-${stem}.json`), "utf8")) as {
    recording_id?: string;
    permissions?: { tap?: string; mic?: string };
  };
  if (!manifest.recording_id) throw new Error(`manifest-${stem}.json has no recording_id`);
  logTools();
  const sidecar: CaptureSidecar = {
    sidecar_version: 1,
    pipeline: "capture",
    recording_id: manifest.recording_id,
    stem,
    capture_dir: dir,
    updated_at: new Date().toISOString(),
    pid: process.pid,
    steps: { transcribe: emptyStep(), classify: emptyStep(), diarize: emptyStep() },
  };
  const write = (): void => {
    sidecar.updated_at = new Date().toISOString();
    sidecar.pid = process.pid;
    writeFileSync(join(dir, `pipeline-${stem}.json`), JSON.stringify(sidecar, null, 2) + "\n");
  };
  const begin = (step: StepName): void => {
    sidecar.steps[step] = { ...emptyStep(), state: "running", started_at: new Date().toISOString() };
    write();
  };
  const finish = (step: StepName, state: StepRecord["state"], detail: Record<string, unknown> | null, error: string | null = null): void => {
    sidecar.steps[step] = { ...sidecar.steps[step], state, ended_at: new Date().toISOString(), detail, error };
    write();
  };

  // --- transcribe: transcribe.py, as the direct pipeline runs it ---
  const transcriptPath = join(dir, `transcript-${stem}.json`);
  begin("transcribe");
  try {
    if (existsSync(transcriptPath)) {
      log("transcript exists");
      finish("transcribe", "skipped", { transcript: transcriptPath, ran: false });
    } else {
      log(`transcribing → ${PYTHON} ${TRANSCRIBE_PY}`);
      // -I: the bundled Python reads no PYTHON* variables and no user site-packages.
      // -B: it writes no compiled files, which would land inside the signed bundle
      // and break its signature (-I ignores PYTHONDONTWRITEBYTECODE, so the flag
      // is what turns it off here).
      execFileSync(PYTHON, ["-I", "-B", TRANSCRIBE_PY, join(dir, `system-${stem}.f32le.pcm`), join(dir, `mic-${stem}.wav`), transcriptPath], { stdio: "inherit", env: TOOL_ENV });
      finish("transcribe", "ok", { transcript: transcriptPath, ran: true });
    }
  } catch (err) {
    finish("transcribe", "failed", null, err instanceof Error ? err.message.split("\n")[0] : String(err));
    throw err;
  }

  // --- classify: the same classifier ingest runs, and the same refusal ---
  begin("classify");
  const doc = JSON.parse(readFileSync(transcriptPath, "utf8")) as { content?: TranscriptContent };
  const classification: CaptureClassification | null = classifyCapture({ content: doc.content, permissions: manifest.permissions });
  if (!classification) {
    finish("classify", "failed", null, "content stats absent from transcript");
    throw new Error("content stats absent from transcript — the capture cannot be classified");
  }
  log(`classify: verdict=${classification.verdict} concern=${classification.concern} excluded=${classification.excludedLabels.join(",") || "none"}`);
  if (classification.verdict === "unusable") {
    finish("classify", "failed", { classification }, `capture is unusable: ${classification.reason}`);
    throw new Error(`capture is unusable: ${classification.reason}`);
  }
  finish("classify", "ok", { classification });

  // --- diarize: the early sidecar, or the binary; best-effort, never a failure ---
  begin("diarize");
  const skip = (reason: string, extra: Record<string, unknown> = {}): void => {
    log(`diarize: skipped — ${reason}`);
    finish("diarize", "skipped", { reason, ...extra });
  };
  const tapWav = join(dir, `system-${stem}.16k.wav`);
  const micWav = join(dir, `mic-${stem}.16k.wav`);
  const diarizeBin = DIARIZE_BIN;
  if (process.arch !== "arm64") {
    skip(`Apple Silicon only — this Mac reports process.arch=${process.arch}`);
  } else if (!existsSync(tapWav)) {
    skip(`tap 16k wav not found at ${tapWav}`);
  } else {
    let got: { sidecar: DiarizeSidecar; usedEarly: boolean; reason: string } | null = null;
    try {
      got = sidecarForCapture(join(dir, `diarize-${stem}.json`), tapWav, micWav, () => {
        if (!existsSync(diarizeBin)) throw new Error(`recorder/diarize binary not found at ${diarizeBin}`);
        execFileSync(diarizeBin, [tapWav, micWav, DIARIZE_MODELS, join(dir, `diarize-${stem}.json`)], { stdio: "inherit", timeout: 120_000 });
        return JSON.parse(readFileSync(join(dir, `diarize-${stem}.json`), "utf8")) as DiarizeSidecar;
      });
    } catch (err) {
      skip(`diarize tool failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    if (got && got.sidecar.error) {
      skip(`diarize tool reported an error: ${got.sidecar.error}`);
    } else if (got) {
      const voices = got.sidecar.voices.length;
      // The naming window is offered for a call the server could split: two
      // voices or more, and a `them` track that is kept. Whether it does split
      // (one guest named outranks the count) is the server's decision.
      let namingData = false;
      let namingError: string | null = null;
      if (voices >= 2 && !classification.excludedLabels.includes("them")) {
        try {
          await generateVoiceNamingData(dir, stem, got.sidecar);
          namingData = true;
        } catch (err) {
          namingError = err instanceof Error ? err.message.split("\n")[0] : String(err);
        }
      }
      log(`diarize: ${voices} voice(s) (${got.usedEarly ? "early run" : "ran the binary"}), naming data ${namingData ? "written" : "not written"}`);
      finish("diarize", "ok", { voices_found: voices, used_early: got.usedEarly, reason: got.reason, naming_data: namingData, naming_error: namingError });
    }
  }
  return sidecar;
}

function usage(): never {
  process.stderr.write("usage: tsx src/pipeline/capture-cli.ts <capture_dir> --stem <stem>\n");
  process.exit(2);
}

// .ts when run through tsx from a checkout, .js when Clipwise.app runs its compiled
// copy on Electron's Node (SAA-198).
if (process.argv[1] && /capture-cli\.(ts|js)$/.test(process.argv[1])) {
  const argv = process.argv.slice(2);
  const dir = argv[0] && !argv[0].startsWith("--") ? resolve(argv[0]) : null;
  const at = argv.indexOf("--stem");
  const stem = at >= 0 ? argv[at + 1] : undefined;
  if (!dir || !stem) usage();
  runCapturePipelineWithoutDatabase(dir, stem)
    .then(() => log("done"))
    .catch((err) => {
      process.stderr.write(`capture-pipeline: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
      process.exitCode = 1;
    });
}
