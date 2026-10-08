// Checks for diarize.ts's use of the sidecar transcribe.py leaves after its
// early voice-separation run (SAA-239): a sidecar is used only when it says
// the binary exited 0 and the two wavs still have the size and mtime it
// recorded; anything else runs the binary as before. No database and no
// binary: temp files and a counting stub. Plain script, exit code 0 on pass.
//
// Usage:
//   tsx src/pipeline/check-early-sidecar.ts
//   tsx src/pipeline/check-early-sidecar.ts --naive          (no match check)
//   tsx src/pipeline/check-early-sidecar.ts --naive-noblock  (early_run not required)
//
// The --naive modes swap in versions with one rule removed. They are the
// negative controls: the cases for that rule must fail against them.

import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sidecarForCapture } from "./diarize.js";

const NAIVE = process.argv.includes("--naive");
const NAIVE_NOBLOCK = process.argv.includes("--naive-noblock");

type Sc = Parameters<typeof sidecarForCapture>[3] extends () => infer R ? R : never;
type Fn = (p: string, t: string, m: string, run: () => Sc) => { sidecar: Sc; usedEarly: boolean; reason: string };

// NAIVE: trusts any sidecar that says exit 0, without looking at the wavs.
const naive: Fn = (p, _t, _m, run) => {
  try {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    if (doc?.early_run?.exit_code === 0) return { sidecar: doc, usedEarly: true, reason: "naive" };
  } catch {
    /* fall through */
  }
  return { sidecar: run(), usedEarly: false, reason: "naive" };
};
// NAIVE_NOBLOCK: uses any parseable sidecar whose wavs match IF it has a block,
// and ALSO any sidecar with no block at all (i.e. an old one).
const naiveNoBlock: Fn = (p, t, m, run) => {
  try {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    if (!doc.early_run) return { sidecar: doc, usedEarly: true, reason: "naive-noblock" };
  } catch {
    /* fall through */
  }
  return sidecarForCapture(p, t, m, run);
};
const use: Fn = NAIVE ? naive : NAIVE_NOBLOCK ? naiveNoBlock : (sidecarForCapture as Fn);

const VOICES = { voices: [{ voiceIndex: 1 }, { voiceIndex: 2 }], segments: [], error: null };
const BINARY_RESULT = { ...VOICES, marker: "from-binary" } as unknown as Sc;

type World = { dir: string; side: string; tap: string; mic: string };
function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "early-sidecar-"));
  const tap = join(dir, "system-S.16k.wav");
  const mic = join(dir, "mic-S.16k.wav");
  writeFileSync(tap, Buffer.alloc(1000, 1));
  writeFileSync(mic, Buffer.alloc(2000, 2));
  return { dir, side: join(dir, "diarize-S.json"), tap, mic };
}
function sig(path: string) {
  const st = statSync(path, { bigint: true });
  return { size: Number(st.size), mtime_ns: String(st.mtimeNs) };
}
function writeSidecar(w: World, early: unknown, extra: Record<string, unknown> = {}) {
  writeFileSync(w.side, JSON.stringify({ ...VOICES, marker: "from-early", ...(early === undefined ? {} : { early_run: early }), ...extra }));
}
const goodBlock = (w: World) => ({ exit_code: 0, tap_wav: sig(w.tap), mic_wav: sig(w.mic), started_by: "transcribe.py" });

type Case = { name: string; run: (w: World) => string | null };
function ran(w: World): { calls: number; res: ReturnType<Fn> } {
  let calls = 0;
  const res = use(w.side, w.tap, w.mic, () => {
    calls++;
    return BINARY_RESULT;
  });
  return { calls, res };
}
const expectIgnored = (w: World, why: RegExp): string | null => {
  const { calls, res } = ran(w);
  if (res.usedEarly) return `used the early sidecar (${res.reason})`;
  if (calls !== 1) return `binary ran ${calls} times, wanted 1`;
  if ((res.sidecar as unknown as { marker: string }).marker !== "from-binary") return "did not return the binary's sidecar";
  return why.test(res.reason) ? null : `reason was "${res.reason}"`;
};

const CASES: Case[] = [
  {
    name: "POSITIVE: a fresh sidecar whose wavs match IS used, and the binary is NOT run",
    run: (w) => {
      writeSidecar(w, goodBlock(w));
      const { calls, res } = ran(w);
      if (!res.usedEarly) return `not used: ${res.reason}`;
      if (calls !== 0) return `binary was run ${calls} time(s)`;
      return (res.sidecar as unknown as { marker: string }).marker === "from-early" ? null : "returned the wrong sidecar";
    },
  },
  {
    name: "an old sidecar with no early_run block is ignored; the binary runs",
    run: (w) => {
      writeSidecar(w, undefined);
      return expectIgnored(w, /no early_run/);
    },
  },
  {
    name: "early_run exit_code 1 is ignored",
    run: (w) => {
      writeSidecar(w, { ...goodBlock(w), exit_code: 1 });
      return expectIgnored(w, /exit status/);
    },
  },
  {
    name: "early_run with no exit_code, or exit_code \"0\" as a string, is ignored",
    run: (w) => {
      const { exit_code: _drop, ...rest } = goodBlock(w);
      writeSidecar(w, rest);
      const a = expectIgnored(w, /exit status/);
      if (a) return `no exit_code: ${a}`;
      writeSidecar(w, { ...goodBlock(w), exit_code: "0" });
      const b = expectIgnored(w, /exit status/);
      return b ? `string "0": ${b}` : null;
    },
  },
  {
    name: "tap wav changed size since the early run: ignored",
    run: (w) => {
      writeSidecar(w, goodBlock(w));
      writeFileSync(w.tap, Buffer.alloc(1001, 1));
      return expectIgnored(w, /tap wav differs/);
    },
  },
  {
    name: "mic wav rewritten to the SAME size a second later (mtime differs only): ignored",
    run: (w) => {
      writeSidecar(w, goodBlock(w));
      const t = statSync(w.mic).mtimeMs / 1000 + 1;
      utimesSync(w.mic, t, t);
      return expectIgnored(w, /mic wav differs/);
    },
  },
  {
    name: "mtime differing by one microsecond is ignored (nanosecond string compare, not mtimeMs)",
    run: (w) => {
      writeSidecar(w, goodBlock(w));
      const before = statSync(w.tap, { bigint: true }).mtimeNs;
      const t = Number(before) / 1e9 + 0.000001;
      utimesSync(w.tap, t, t);
      const after = statSync(w.tap, { bigint: true }).mtimeNs;
      if (after === before) return "could not move the mtime by a microsecond on this filesystem";
      return expectIgnored(w, /tap wav differs/);
    },
  },
  {
    name: "a wav the early run used is gone: ignored",
    run: (w) => {
      writeSidecar(w, goodBlock(w));
      rmSync(w.mic);
      return expectIgnored(w, /mic wav not readable/);
    },
  },
  {
    name: "mtime_ns stored as a JSON number instead of a string: ignored",
    run: (w) => {
      const g = goodBlock(w);
      writeSidecar(w, { ...g, tap_wav: { size: g.tap_wav.size, mtime_ns: Number(g.tap_wav.mtime_ns) } });
      return expectIgnored(w, /usable tap wav record/);
    },
  },
  {
    name: "garbled, empty and missing sidecar files are ignored",
    run: (w) => {
      writeFileSync(w.side, "{not json");
      const a = expectIgnored(w, /no readable sidecar/);
      if (a) return `garbled: ${a}`;
      writeFileSync(w.side, "");
      const b = expectIgnored(w, /no readable sidecar/);
      if (b) return `empty: ${b}`;
      rmSync(w.side);
      const c = expectIgnored(w, /no readable sidecar/);
      return c ? `missing: ${c}` : null;
    },
  },
  {
    name: "when the binary has to run and fails, its error propagates to the caller (skip-on-failure is the caller's)",
    run: (w) => {
      try {
        use(w.side, w.tap, w.mic, () => {
          throw new Error("diarize tool failed");
        });
      } catch (e) {
        return String(e).includes("diarize tool failed") ? null : `threw ${String(e)}`;
      }
      return "did not throw";
    },
  },
  {
    name: "diarize.ts: the binary is only reached through sidecarForCapture, and mtime is read as bigint nanoseconds",
    run: () => {
      const src = readFileSync(resolve(import.meta.dirname, "..", "..", "src", "pipeline", "diarize.ts"), "utf8");
      const calls = src.split("execFileSync(diarizeBin").length - 1;
      const within = /sidecarForCapture\([^)]*\(\) => \{[\s\S]*?execFileSync\(diarizeBin/.test(src);
      if (calls !== 1 || !within) return `execFileSync(diarizeBin appears ${calls} time(s); inside sidecarForCapture callback: ${within}`;
      if (!/statSync\(path, \{ bigint: true \}\)/.test(src) || !/String\(st\.mtimeNs\)/.test(src)) return "no bigint mtimeNs comparison";
      if (/mtimeMs/.test(src)) return "diarize.ts reads mtimeMs";
      return null;
    },
  },
];

function main(): number {
  let failures = 0;
  for (const c of CASES) {
    const w = world();
    let why: string | null;
    try {
      why = c.run(w);
    } catch (e) {
      why = `threw ${String(e)}`;
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
    process.stdout.write(`${why === null ? "PASS" : "FAIL"} ${c.name}${why === null ? "" : ` — ${why}`}\n`);
    if (why !== null) failures += 1;
  }
  const mode = NAIVE ? " (--naive)" : NAIVE_NOBLOCK ? " (--naive-noblock)" : "";
  process.stdout.write(`\n${CASES.length - failures}/${CASES.length} passed${mode}\n`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
