#!/usr/bin/env python3
"""Checks for transcribe.py's early voice-separation run (SAA-239).

Stub shell scripts stand in for the real binary: no models, no audio, no
database. Plain script, exit code 0 on pass.

    python3 check-early-diarize.py
    python3 check-early-diarize.py --naive     # exit hook disabled: the orphan case must fail

What is checked: the early run starts without blocking and its sidecar gets the
early_run block (exit status plus size and mtime of both wavs); a failed, hung,
silent or garbled run leaves no sidecar and never raises; a sidecar that
already exists is untouched by a failed run; a wav that changes while it runs
voids it; nothing is started where it should not be; the child never outlives
a transcript that fails; and main() starts it after downsampling and waits for
it after the transcript is written.
"""
import json, os, platform, signal, stat, subprocess, sys, tempfile, textwrap, time
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import transcribe as T  # noqa: E402

NAIVE = "--naive" in sys.argv
GOOD = json.dumps({"voices": [{"voiceIndex": 1}, {"voiceIndex": 2}], "segments": [], "error": None})


def stub(dirp: Path, name: str, body: str) -> str:
    p = dirp / name
    p.write_text("#!/bin/sh\n" + textwrap.dedent(body))
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(p)


def world():
    d = Path(tempfile.mkdtemp(prefix="early-diarize-"))
    tap, mic = d / "system-S.16k.wav", d / "mic-S.16k.wav"
    tap.write_bytes(b"\x01" * 1000)
    mic.write_bytes(b"\x02" * 2000)
    (d / "models").mkdir()
    return d, tap, mic


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def env(binary, **extra):
    os.environ["DIARIZE_BIN"] = binary
    os.environ["DIARIZE_MODELS"] = extra.pop("models", "")
    os.environ.pop("CLIPWISE_EARLY_DIARIZE", None)
    for k, v in extra.items():
        os.environ[k] = v


CASES = []
def case(f):
    CASES.append(f); return f


@case
def success_gets_early_run_block_and_does_not_block_the_start():
    d, tap, mic = world()
    env(stub(d, "ok.sh", f'sleep 0.5\ncat > "$4" <<EOF\n{GOOD}\nEOF\n'), models=str(d / "models"))
    t0 = time.monotonic(); h = T.start_early_diarize(tap, mic); started_in = time.monotonic() - t0
    if h is None: return "did not start"
    if started_in > 0.3: return f"start blocked for {started_in:.2f}s"
    ok = T.finish_early_diarize(h)
    side = d / "diarize-S.json"
    if not ok or not side.is_file(): return "no sidecar published"
    doc = json.loads(side.read_text()); er = doc.get("early_run")
    if not er or er.get("exit_code") != 0: return f"early_run block: {er}"
    if er["tap_wav"] != {"size": 1000, "mtime_ns": str(tap.stat().st_mtime_ns)}: return f"tap record {er['tap_wav']}"
    if er["mic_wav"] != {"size": 2000, "mtime_ns": str(mic.stat().st_mtime_ns)}: return f"mic record {er['mic_wav']}"
    if not isinstance(er["tap_wav"]["mtime_ns"], str): return "mtime_ns is not a string"
    left = sorted(p.name for p in d.iterdir() if p.name.startswith("diarize-"))
    return None if left == ["diarize-S.json"] else f"leftover files {left}"


@case
def finish_waits_for_the_run():
    d, tap, mic = world()
    env(stub(d, "slow.sh", f'sleep 0.8\ncat > "$4" <<EOF\n{GOOD}\nEOF\n'), models=str(d / "models"))
    h = T.start_early_diarize(tap, mic); t0 = time.monotonic()
    ok = T.finish_early_diarize(h); waited = time.monotonic() - t0
    return None if ok and waited > 0.4 else f"ok={ok}, waited {waited:.2f}s"


@case
def failed_run_leaves_no_sidecar_and_does_not_raise():
    d, tap, mic = world()
    env(stub(d, "fail.sh", 'echo partial > "$4"\nexit 3\n'), models=str(d / "models"))
    h = T.start_early_diarize(tap, mic)
    ok = T.finish_early_diarize(h)
    left = sorted(p.name for p in d.iterdir() if p.name.startswith("diarize-"))
    return None if ok is False and left == [] else f"ok={ok}, left {left}"


@case
def an_existing_sidecar_survives_a_failed_run_and_is_replaced_by_a_good_one():
    d, tap, mic = world()
    side = d / "diarize-S.json"; side.write_text("OLD")
    env(stub(d, "fail.sh", 'echo partial > "$4"\nexit 3\n'), models=str(d / "models"))
    T.finish_early_diarize(T.start_early_diarize(tap, mic))
    if side.read_text() != "OLD": return f"failed run changed the existing sidecar to {side.read_text()[:30]!r}"
    env(stub(d, "ok.sh", f'cat > "$4" <<EOF\n{GOOD}\nEOF\n'), models=str(d / "models"))
    if not T.finish_early_diarize(T.start_early_diarize(tap, mic)): return "good run not published"
    return None if "early_run" in json.loads(side.read_text()) else "existing sidecar not replaced"


@case
def a_hung_run_is_killed_at_the_budget_and_leaves_nothing():
    d, tap, mic = world()
    env(stub(d, "hang.sh", 'echo $$ > "$(dirname "$4")/pid"\nexec sleep 60\n'), models=str(d / "models"))
    h = T.start_early_diarize(tap, mic, budget_s=1.0)
    t0 = time.monotonic(); ok = T.finish_early_diarize(h); took = time.monotonic() - t0
    pid = int((d / "pid").read_text())
    time.sleep(0.2)
    if ok: return "reported success"
    if took > 6: return f"took {took:.1f}s"
    if alive(pid): os.kill(pid, signal.SIGKILL); return "the hung process was left running"
    return None if not (d / "diarize-S.json").exists() else "sidecar exists"


@case
def exit_zero_without_a_file_or_with_garbage_is_not_used():
    for body, label in (('exit 0\n', "no file"), ('echo "{oops" > "$4"\n', "garbage"), ('echo "[1,2]" > "$4"\n', "not an object")):
        d, tap, mic = world()
        env(stub(d, "x.sh", body), models=str(d / "models"))
        ok = T.finish_early_diarize(T.start_early_diarize(tap, mic))
        if ok or (d / "diarize-S.json").exists(): return f"{label}: ok={ok}, sidecar exists={(d / 'diarize-S.json').exists()}"
    return None


@case
def a_wav_that_changes_while_it_runs_voids_the_run():
    d, tap, mic = world()
    env(stub(d, "touch.sh", f'sleep 0.2\ntouch -t 200001010000 "$(dirname "$4")/system-S.16k.wav"\ncat > "$4" <<EOF\n{GOOD}\nEOF\n'), models=str(d / "models"))
    ok = T.finish_early_diarize(T.start_early_diarize(tap, mic))
    return None if ok is False and not (d / "diarize-S.json").exists() else f"ok={ok}"


@case
def not_started_when_it_should_not_be():
    d, tap, mic = world()
    good = stub(d, "ok.sh", f'cat > "$4" <<EOF\n{GOOD}\nEOF\n')
    out = []
    env("/nonexistent/diarize", models=str(d / "models")); out.append(("no binary", T.start_early_diarize(tap, mic)))
    env(good, models=str(d / "nomodels")); out.append(("no models", T.start_early_diarize(tap, mic)))
    env(good, models=str(d / "models"), CLIPWISE_EARLY_DIARIZE="off"); out.append(("off", T.start_early_diarize(tap, mic)))
    env(good, models=str(d / "models"), CLIPWISE_EARLY_DIARIZE="sometimes"); out.append(("bad mode", T.start_early_diarize(tap, mic)))
    env(good, models=str(d / "models")); out.append(("odd name", T.start_early_diarize(d / "tap.wav", mic)))
    real = platform.machine
    try:
        T.platform.machine = lambda: "x86_64"; out.append(("not arm64", T.start_early_diarize(tap, mic)))
    finally:
        T.platform.machine = real
    bad = [n for n, h in out if h is not None]
    left = sorted(p.name for p in d.iterdir() if p.name.startswith("diarize-"))
    return None if not bad and not left else f"started despite: {bad}; files {left}"


@case
def a_transcript_that_fails_never_leaves_the_child_running():
    d, tap, mic = world()
    binary = stub(d, "hang.sh", 'echo $$ > "$(dirname "$4")/pid"\nexec sleep 60\n')
    code = textwrap.dedent(f"""
        import sys; sys.dont_write_bytecode = True; sys.path.insert(0, {str(HERE)!r})
        import atexit, os, transcribe as T
        {'atexit.register = lambda *a, **k: None' if NAIVE else ''}
        os.environ['DIARIZE_BIN'] = {binary!r}; os.environ['DIARIZE_MODELS'] = {str(d / 'models')!r}
        from pathlib import Path
        T.start_early_diarize(Path({str(tap)!r}), Path({str(mic)!r}))
        import time; time.sleep(0.5)
        sys.exit(1)   # what die() does mid-transcript
    """)
    # DEVNULL, not a pipe: an orphaned child would hold a captured pipe open and turn a plain FAIL into a hang.
    subprocess.run([sys.executable, "-c", code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    time.sleep(0.5)
    pidf = d / "pid"
    if not pidf.exists(): return "stub never started"
    pid = int(pidf.read_text())
    if alive(pid):
        os.kill(pid, signal.SIGKILL)
        return "the child was still running after the transcript process exited"
    return None if not any(p.name.startswith("diarize-") for p in d.iterdir()) else "partial output left behind"


@case
def main_starts_it_after_downsampling_and_waits_after_the_transcript_is_written():
    src = (HERE / "transcribe.py").read_text()
    m = src[src.index("def main()"):]
    i_dl = m.index("ffmpeg_downsample_wav(mic_src, mic_16k)")
    i_start = m.index("start_early_diarize(tap_16k, mic_16k)")
    i_aec = m.index('if aec_plan["run"]:', i_dl)
    i_write = m.index("out_path.write_text(")
    i_fin = m.index("finish_early_diarize(early_diarize)")
    if not (i_dl < i_start < i_aec): return "start is not between the downsample and echo removal"
    if not (i_write < i_fin): return "finish is not after the transcript is written"
    return None if m.count("start_early_diarize(") == 1 and m.count("finish_early_diarize(") == 1 else "called more than once"


fails = 0
for f in CASES:
    try:
        why = f()
    except Exception as e:
        why = f"raised {type(e).__name__}: {e}"
    print(("PASS " if why is None else "FAIL ") + f.__name__.replace("_", " ") + ("" if why is None else f" — {why}"))
    fails += why is not None
print(f"\n{len(CASES) - fails}/{len(CASES)} passed" + (" (--naive)" if NAIVE else ""))
sys.exit(1 if fails else 0)
