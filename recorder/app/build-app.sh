#!/bin/bash
# Build Clipwise.app — a double-clickable menu bar app, signed with the
# Developer ID from SAA-88.
#
# What this replaces. Nothing: there was no build script. The steps it
# automates were done by hand from the README, which had drifted (it builds
# audiodevs and systemtap and never mentions miccap, which replaced ffmpeg on
# the mic in SAA-106). This is the first script that produces a runnable
# artifact rather than measuring one — baseline.sh is a capture harness and
# fix-electron-signature.sh is an install hook.
#
# What it deliberately does not do. No notarization, no stapling and no DMG:
# those need an Apple notary profile and are notarize.sh's, run after this. No
# auto-update: a new version replaces the app by hand. Launch at login is not
# this script's either: the app registers itself the first time it runs from
# Applications with setup finished, and the tray's "Open at login" turns it off
# (SAA-198 step 4).
#
# Signed with the hardened runtime (SAA-198 engineering call 6, SAA-126): every
# executable in the bundle, inside-out, with only the entitlements it needs.
# See section 4.

set -euo pipefail

IDENTITY="${CLIPWISE_SIGN_IDENTITY:-Developer ID Application: Clipwise LLC (94U8UWWFSL)}"
BUNDLE_ID="com.clipwise.recorder"
APP_NAME="Clipwise"

APP_SRC="$(cd "$(dirname "$0")" && pwd)"
RECORDER_DIR="$(cd "$APP_SRC/.." && pwd)"
REPO_DIR="$(cd "$RECORDER_DIR/.." && pwd)"
SERVER_DIR="$REPO_DIR/server"
ELECTRON_DIST="$APP_SRC/node_modules/electron/dist"
ELECTRON_APP="$ELECTRON_DIST/Electron.app"

# Fixed output path, and that is load-bearing rather than tidiness. A TCC grant
# may key on the bundle path; Architecture Decision #9 leaves path and signing
# identity explicitly unruled-out as what a grant actually attaches to. A build
# that landed somewhere new each time would make "did the grant survive?"
# uninterpretable, and it is also the path Login Items records.
OUT_DIR="$APP_SRC/dist"
APP="$OUT_DIR/$APP_NAME.app"

step() { printf '\n=== %s\n' "$*"; }

# --- 1. helper binaries ---------------------------------------------------
# All four are gitignored build outputs, so a fresh clone has none of them.

step "building helper binaries"
(cd "$RECORDER_DIR" && swiftc -O audiodevs.swift -o audiodevs)
(cd "$RECORDER_DIR" && swiftc -O micwatch.swift -o micwatch)
swift build -c release --package-path "$RECORDER_DIR/systemtap"
swift build -c release --package-path "$RECORDER_DIR/miccap"
swift build -c release --package-path "$RECORDER_DIR/diarize"
swift build -c release --package-path "$RECORDER_DIR/parakeet"
# SAA-218: WebRTC AEC3, for removing speaker echo from the mic. Needs meson and ninja.
"$RECORDER_DIR/aec/build.sh"
# SAA-198: the pipeline's own ffmpeg (LGPL-only) and Python, so the bundle takes
# neither from the Mac it runs on.
"$RECORDER_DIR/ffmpeg/build.sh"
"$RECORDER_DIR/python/fetch.sh"

SYSTEMTAP_BIN="$RECORDER_DIR/systemtap/.build/release/systemtap"
MICCAP_BIN="$RECORDER_DIR/miccap/.build/release/miccap"
AUDIODEVS_BIN="$RECORDER_DIR/audiodevs"
MICWATCH_BIN="$RECORDER_DIR/micwatch"
DIARIZE_BIN="$RECORDER_DIR/diarize/.build/release/diarize"
PARAKEET_BIN="$RECORDER_DIR/parakeet/.build/release/parakeet"
AEC_BIN="$RECORDER_DIR/aec/.build/release/aec"
FFMPEG_BIN="$RECORDER_DIR/ffmpeg/.build/release/ffmpeg"
PYTHON_DIR="$RECORDER_DIR/python/.build/python"

for b in "$SYSTEMTAP_BIN" "$MICCAP_BIN" "$AUDIODEVS_BIN" "$MICWATCH_BIN" "$DIARIZE_BIN" "$PARAKEET_BIN" "$AEC_BIN" "$FFMPEG_BIN" "$PYTHON_DIR/bin/python3"; do
    [ -x "$b" ] || { echo "build-app: missing $b after build" >&2; exit 1; }
done
# The ffmpeg that ships must be the LGPL build, never a GPL or nonfree one.
"$FFMPEG_BIN" -hide_banner -L | grep -q "GNU Lesser General Public" \
    || { echo "build-app: $FFMPEG_BIN does not report the LGPL" >&2; exit 1; }

# SAA-194: the community-1 model files diarize loads at runtime. Fetched (and
# checksum-verified against recorder/diarize/models/CHECKSUMS.sha256) rather
# than committed — see fetch-models.sh's own header for why. Re-fetches only
# when missing or when verification fails, so a build with the models already
# present and intact does not touch the network.
step "fetching speaker-diarization models"
"$RECORDER_DIR/diarize/fetch-models.sh"
DIARIZE_MODELS_DIR="$RECORDER_DIR/diarize/models/speaker-diarization"
[ -d "$DIARIZE_MODELS_DIR" ] || { echo "build-app: missing $DIARIZE_MODELS_DIR after fetch-models.sh" >&2; exit 1; }

# SAA-220: the Parakeet TDT 0.6B v2 model files transcribe.py's default engine
# loads at runtime. Fetched and checksum-verified like the diarization models
# above. Copied into the bundle (443 MB): the app reads no network at run time
# (SAA-198, engineering call 2).
step "fetching Parakeet models"
"$RECORDER_DIR/parakeet/fetch-models.sh"
PARAKEET_MODELS_DIR="$RECORDER_DIR/parakeet/models/parakeet-tdt-0.6b-v2"
[ -d "$PARAKEET_MODELS_DIR" ] || { echo "build-app: missing $PARAKEET_MODELS_DIR after fetch-models.sh" >&2; exit 1; }

# --- 2. the Electron runtime ----------------------------------------------
#
# Not fetched by `npm install`: Electron 43's package manifest has no `scripts`
# key, so the install exits clean while leaving no runtime on disk. `npx
# install-electron` is what downloads it. Checked rather than assumed, because
# the failure is silent in exactly that way.

if [ ! -d "$ELECTRON_APP" ]; then
    echo "build-app: no Electron runtime at $ELECTRON_APP" >&2
    echo "           run: (cd $APP_SRC && npm install && npx install-electron)" >&2
    exit 1
fi

step "assembling $APP"
rm -rf "$APP"
mkdir -p "$OUT_DIR"
# ditto rather than cp -R: the Electron framework is built out of symlinks and
# a copy that flattens them is not a loadable framework.
ditto "$ELECTRON_APP" "$APP"

C="$APP/Contents"

# The executable's name is what `ps` and Activity Monitor show, and it is also
# what Electron's own app.isPackaged reads. Nothing in main.js depends on that
# getter — see BUILD_INFO there — but leaving three "Electron" processes in the
# process list of a machine that also runs Electron apps is its own confusion.
mv "$C/MacOS/Electron" "$C/MacOS/$APP_NAME"

# Electron loads Resources/app before Resources/default_app.asar. Removing the
# default app removes any question of which one ran, and takes the asar
# integrity hash in Info.plist with it — a stale hash against a missing file is
# a launch failure waiting for a fuse to be flipped.
rm -f "$C/Resources/default_app.asar"
# Electron's own icon goes, and ours takes its place (SAA-130). Until now the
# bundle shipped with no icon at all, deliberately — the reasoning recorded here
# was that a generic icon is not worse than a wrong one, and Electron's icon
# beside the name Clipwise in Login Items is a wrong one. That trade expires the
# moment a real icon exists.
rm -f "$C/Resources/electron.icns"
if [ -f "$APP_SRC/assets/$APP_NAME.icns" ]; then
  cp "$APP_SRC/assets/$APP_NAME.icns" "$C/Resources/$APP_NAME.icns"
else
  echo "build-app: assets/$APP_NAME.icns missing — run assets/render.swift, see assets/README.md" >&2
  exit 1
fi

mkdir -p "$C/Resources/app" "$C/Resources/bin" "$C/Resources/tray" "$C/Resources/models"
# The tray marks (SAA-130). main.js resolves these at Resources/tray when it is
# running from a bundle, and falls back to a generated dot if one cannot be
# read — but a bundle that ships without them is a bundle whose menu bar icon
# silently degrades, so the copy is checked here rather than left to chance.
cp "$APP_SRC/assets/tray/"*.png "$C/Resources/tray/"
TRAY_COUNT=$(ls -1 "$C/Resources/tray/" | wc -l | tr -d ' ')
if [ "$TRAY_COUNT" -ne 16 ]; then
  echo "build-app: expected 16 tray marks (4 states x template/colour x 1x/2x), got $TRAY_COUNT" >&2
  exit 1
fi
cp "$APP_SRC/main.js" "$C/Resources/app/main.js"
# The identity prompt's page (SAA-114). main.js loads it by path relative to
# itself, so a bundle without it has a stop that silently identifies nothing.
cp "$APP_SRC/identity.html" "$C/Resources/app/identity.html"
cp "$APP_SRC/identity-answer.js" "$C/Resources/app/identity-answer.js"
# Step 2's stop-waiting decision (SAA-195). main.js requires this by
# relative path; a bundle without it fails to launch, same as the others.
cp "$APP_SRC/voice-naming-wait.js" "$C/Resources/app/voice-naming-wait.js"
# Which meeting the tray's "Save transcript" item names (SAA-199). main.js
# requires this by relative path; a bundle without it fails to launch.
cp "$APP_SRC/last-meeting.js" "$C/Resources/app/last-meeting.js"
# The recent-meetings window (SAA-217): its page and the code that lists its rows.
# main.js requires meetings.js and loads meetings.html by path relative to itself.
cp "$APP_SRC/meetings.js" "$C/Resources/app/meetings.js"
cp "$APP_SRC/meetings.html" "$C/Resources/app/meetings.html"
# App -> scope inference (SAA-170). main.js requires this by relative path;
# a bundle without it fails to launch at all, not just to infer scope.
cp "$APP_SRC/app-scope.js" "$C/Resources/app/app-scope.js"
# The auto-stop decision (SAA-184). main.js requires this by relative path; a
# bundle without it fails to launch.
cp "$APP_SRC/autostop.js" "$C/Resources/app/autostop.js"
# The "Still recording?" reminder's decision. main.js requires it by relative
# path; a bundle without it fails to launch.
cp "$APP_SRC/silence-reminder.js" "$C/Resources/app/silence-reminder.js"
# The first-run acknowledgement (SAA-216) and the setup window it is now the
# first screen of (SAA-198 step 4). main.js requires consent.js and setup.js by
# relative path and loads setup.html by path relative to itself; a bundle
# without either .js fails to launch, and without the page the gate would shut
# with nothing to open.
cp "$APP_SRC/consent.js" "$C/Resources/app/consent.js"
cp "$APP_SRC/setup.js" "$C/Resources/app/setup.js"
cp "$APP_SRC/setup.html" "$C/Resources/app/setup.html"
# The tray's Sign out revokes on the server (SAA-198 step 5). main.js requires it
# by relative path; a bundle without it fails to launch.
cp "$APP_SRC/capture-sign-out.js" "$C/Resources/app/capture-sign-out.js"
# The capture token's refresh. main.js requires it by relative path; a bundle
# without it fails to launch.
cp "$APP_SRC/capture-refresh.js" "$C/Resources/app/capture-refresh.js"
# Delete from the trash (SAA-243 item 7). main.js requires it by relative path;
# a bundle without it fails to launch.
cp "$APP_SRC/capture-files.js" "$C/Resources/app/capture-files.js"
# The day log's lines where call content is at hand (SAA-243 item 7). main.js
# requires it by relative path; a bundle without it fails to launch.
cp "$APP_SRC/log-lines.js" "$C/Resources/app/log-lines.js"
# Day logs kept for 30 days (SAA-243 item 7). main.js requires it by relative
# path; a bundle without it fails to launch.
cp "$APP_SRC/day-logs.js" "$C/Resources/app/day-logs.js"
# The capture body (SAA-260 step 3). main.js requires it by relative path; a
# bundle without it fails to launch.
cp "$APP_SRC/capture-payload.js" "$C/Resources/app/capture-payload.js"
# Setup's FileVault warning (SAA-243 item 7). main.js requires it by relative
# path; a bundle without it fails to launch.
cp "$APP_SRC/filevault.js" "$C/Resources/app/filevault.js"
# The permission gate at start and the system audio prompt's process (SAA-124).
# main.js requires both by relative path; a bundle without them fails to launch.
cp "$APP_SRC/start-gate.js" "$C/Resources/app/start-gate.js"
cp "$APP_SRC/prompt-child.js" "$C/Resources/app/prompt-child.js"
# When a downloaded update may be applied (SAA-253). main.js requires it by
# relative path; a bundle without it fails to launch.
cp "$APP_SRC/update-gate.js" "$C/Resources/app/update-gate.js"
install -m 755 "$SYSTEMTAP_BIN" "$C/Resources/bin/systemtap"
install -m 755 "$MICCAP_BIN"    "$C/Resources/bin/miccap"
install -m 755 "$AUDIODEVS_BIN" "$C/Resources/bin/audiodevs"
# Call detection (SAA-113). A bundle without it still records on the hotkey;
# main.js logs the absence and disables detection rather than failing to start.
install -m 755 "$MICWATCH_BIN"  "$C/Resources/bin/micwatch"
# The capture pipeline's tools (SAA-198). main.js names each one by its path
# here (PIPELINE_TOOLS_ENV); the pipeline reads nothing from a checkout or PATH.
install -m 755 "$DIARIZE_BIN"   "$C/Resources/bin/diarize"
install -m 755 "$PARAKEET_BIN"  "$C/Resources/bin/parakeet"
install -m 755 "$AEC_BIN"       "$C/Resources/bin/aec"
install -m 755 "$FFMPEG_BIN"    "$C/Resources/bin/ffmpeg"
# The Swift tools' debug symbols out of their bundle copies, before signing:
# their debug map names the build machine's paths (the package, SwiftPM's
# checkouts and intermediates). The build fails if a copy still names the
# checkout.
for b in systemtap miccap diarize parakeet; do
    strip -S "$C/Resources/bin/$b"
    if grep -qaF "$REPO_DIR" "$C/Resources/bin/$b"; then
        echo "build-app: $C/Resources/bin/$b still names $REPO_DIR after strip -S" >&2; exit 1
    fi
done
# .mlmodelc directories are plain resource trees, not nested code — no
# separate signing step; they're swept into the outer codesign call below
# the same as the tray PNGs are. Each model set sits in its own directory, the
# one transcribe.py and diarize are handed (DIARIZE_MODELS, PARAKEET_MODELS).
mkdir -p "$C/Resources/models/diarize" "$C/Resources/models/parakeet"
cp -R "$DIARIZE_MODELS_DIR" "$C/Resources/models/diarize/speaker-diarization"
cp -R "$PARAKEET_MODELS_DIR" "$C/Resources/models/parakeet/parakeet-tdt-0.6b-v2"
# The standalone Python. ditto keeps its symlinks (bin/python3).
ditto "$PYTHON_DIR" "$C/Resources/python"
# Less the parts the pipeline never runs (SAA-198 step 7): pip and ensurepip, and
# Tcl/Tk (its two dylibs, its five folders, and the _tkinter module that loads
# them). An import trace of transcribe.py on a real capture (10-13) touched none
# of them; what is left is what THIRD_PARTY_NOTICES covers for Python. Removed
# here, before signing, so nothing signed is changed afterwards.
PY="$C/Resources/python"
rm -rf "$PY/lib/python3.14/site-packages/pip" "$PY/lib/python3.14/site-packages/pip-"*.dist-info \
       "$PY/lib/python3.14/ensurepip" \
       "$PY/bin/pip" "$PY/bin/pip3" "$PY/bin/pip3.14" \
       "$PY/lib/libtcl9.0.dylib" "$PY/lib/libtcl9tk9.0.dylib" \
       "$PY/lib/tcl9" "$PY/lib/tcl9.0" "$PY/lib/tk9.0" "$PY/lib/itcl4.3.8" "$PY/lib/thread3.0.6" \
       "$PY/lib/python3.14/lib-dynload/_tkinter.cpython-314-darwin.so"
# Also the tkinter package and IDLE, which need Tcl/Tk, and _dbm: none is in
# transcribe.py's import graph (modulefinder, 10-14).
rm -rf "$PY/lib/python3.14/tkinter" "$PY/lib/python3.14/idlelib" "$PY/bin/idle3" "$PY/bin/idle3.14" \
       "$PY/lib/python3.14/lib-dynload/_dbm.cpython-314-darwin.so"
# And every __pycache__ folder the build machine's Python left: compiled files
# that name its paths. The app's own runs write none (PYTHONDONTWRITEBYTECODE in
# main.js), so nothing under the signed bundle changes after signing.
find "$PY" -type d -name __pycache__ -prune -exec rm -rf {} +
for gone in "$PY/lib/python3.14/site-packages/pip" "$PY/lib/python3.14/ensurepip" "$PY/lib/libtcl9.0.dylib" "$PY/lib/tk9.0" \
            "$PY/lib/python3.14/tkinter" "$PY/lib/python3.14/idlelib" "$PY/bin/idle3" \
            "$PY/lib/python3.14/lib-dynload/_dbm.cpython-314-darwin.so"; do
  [ ! -e "$gone" ] || { echo "build-app: $gone is still in the bundle" >&2; exit 1; }
done
[ -z "$(find "$PY" -type d -name __pycache__ -print -quit)" ] || { echo "build-app: a __pycache__ folder is still in the bundle" >&2; exit 1; }
cp "$REPO_DIR/THIRD_PARTY_NOTICES" "$C/Resources/THIRD_PARTY_NOTICES"
# Electron's own licence and the notices of everything Chromium bundles (Node.js,
# V8, Squirrel.Mac and the rest), beside THIRD_PARTY_NOTICES, which names them:
# LICENSES.chromium.html is about 20 MB, too large to fold into it.
cp "$ELECTRON_DIST/LICENSE" "$C/Resources/LICENSE.electron"
cp "$ELECTRON_DIST/LICENSES.chromium.html" "$C/Resources/LICENSES.chromium.html"

# The pipeline, compiled (SAA-198, engineering call 3): the five files capture-cli
# and capture-recover reach, as JavaScript that the app's own executable runs as
# Node. transcribe.py goes beside them. The package.json marks them ES modules.
# --typeRoots names the server's own @types: with files on the command line tsc
# reads no tsconfig, and would otherwise look for them from the folder the build
# was started in.
step "compiling the capture pipeline"
PIPELINE_OUT="$C/Resources/pipeline"
"$SERVER_DIR/node_modules/.bin/tsc" \
    "$SERVER_DIR/src/pipeline/capture-cli.ts" "$SERVER_DIR/src/pipeline/capture-recover.ts" \
    --outDir "$PIPELINE_OUT" --rootDir "$SERVER_DIR/src" \
    --module nodenext --moduleResolution nodenext --target es2023 \
    --skipLibCheck --types node --typeRoots "$SERVER_DIR/node_modules/@types"
printf '{ "type": "module" }\n' > "$PIPELINE_OUT/package.json"
cp "$RECORDER_DIR/transcribe.py" "$PIPELINE_OUT/transcribe.py"
for f in pipeline/capture-cli.js pipeline/capture-recover.js pipeline/classify-capture.js pipeline/voice-clips.js lib/trash-marker.js; do
    [ -f "$PIPELINE_OUT/$f" ] || { echo "build-app: missing $PIPELINE_OUT/$f after tsc" >&2; exit 1; }
done

# The build number goes up with every build (SAA-198 engineering call 11): the
# build's UTC time to the minute, YYYYMMDDHHMM. No counter file to keep, and a
# replaced app is always newer by this number than the one it replaced.
BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"
# The version is the source's major.minor with the build number as its patch
# (SAA-253 decision 2): 0.1.202610291200. app.getVersion() reads it from the
# trimmed package.json below, and the update feed compares it as SemVer, so
# every build is newer than the one before. The source package.json keeps
# x.y.0 and needs no commit per build.
BASE_VERSION="$(/usr/bin/sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP_SRC/package.json" | head -1)"
VERSION="${BASE_VERSION%.*}.$BUILD_NUMBER"
ELECTRON_VERSION="$(cat "$APP_SRC/node_modules/electron/dist/version")"

# A trimmed manifest rather than a copy. The source package.json carries the
# postinstall hook and the electron devDependency, neither of which means
# anything inside a bundle that has already been built.
cat > "$C/Resources/app/package.json" <<JSON
{
  "name": "clipwise-recorder",
  "version": "$VERSION",
  "private": true,
  "description": "Clipwise recorder menu bar app (packaged).",
  "main": "main.js"
}
JSON

COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
DIRTY=false
# Dirty is anything git status lists: a modified tracked file or an untracked
# one, since this script copies named source files into the bundle and an
# untracked one would ship without being in COMMIT (SAA-253: release-zip.sh
# refuses a dirty build). Gitignored build inputs are not listed.
[ -z "$(git -C "$REPO_DIR" status --porcelain)" ] || DIRTY=true
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# This file is two things at once: the flag that tells main.js it is running
# from a bundle, and — because built_at changes every run — the thing that
# guarantees two builds of identical source still hash differently. That second
# one is what makes "does the grant survive a rebuild?" a real question rather
# than a tautology about an unchanged binary. It names no path on the build
# machine (SAA-198): the bundle finds everything relative to itself.
cat > "$C/Resources/app/build-info.json" <<JSON
{
  "built_at": "$BUILT_AT",
  "commit": "$COMMIT",
  "dirty": $DIRTY,
  "electron_version": "$ELECTRON_VERSION",
  "version": "$VERSION"
}
JSON

# --- 3. Info.plist --------------------------------------------------------
#
# Edited in place rather than written from scratch: Electron needs keys here
# that have nothing to do with Clipwise (NSPrincipalClass, NSMainNibFile, the
# MallocNanoZone environment) and a hand-written plist would drop them.

step "Info.plist"
PLIST="$C/Info.plist"
PB=/usr/libexec/PlistBuddy
set_key() { $PB -c "Delete :$1" "$PLIST" >/dev/null 2>&1 || true; $PB -c "Add :$1 $2 $3" "$PLIST"; }

set_key CFBundleName            string "$APP_NAME"
set_key CFBundleDisplayName     string "$APP_NAME"
set_key CFBundleExecutable      string "$APP_NAME"
set_key CFBundleIdentifier      string "$BUNDLE_ID"
set_key CFBundleShortVersionString string "$VERSION"
# The build number (BUILD_NUMBER above), also the version's patch.
set_key CFBundleVersion         string "$BUILD_NUMBER"
# Menu bar only, no Dock icon (SAA-198, Jon's call 6). The paired
# app.dock.hide() in main.js runs after the app is up, so without this key a
# login launch flashes a Dock icon and steals focus from whatever the user is
# doing. The two are halves of one setting (SAA-105, whose experiment set this
# false and removed the runtime call).
set_key LSUIElement             bool   true
# Electron's own permission texts for devices Clipwise never uses (SAA-198
# engineering call 11): a camera or Bluetooth prompt with "This app needs
# access to …" would be a prompt for something the app does not do.
for key in NSCameraUsageDescription NSBluetoothPeripheralUsageDescription NSBluetoothAlwaysUsageDescription; do
    $PB -c "Delete :$key" "$PLIST" >/dev/null 2>&1 || true
done
# Core Audio Taps floor, not Electron's 12.0.
set_key LSMinimumSystemVersion  string "14.2"
# The text macOS puts in the permission prompt. The capture runs in spawned
# children with no bundle of their own, so TCC reads these off the responsible
# app — this bundle.
set_key NSMicrophoneUsageDescription string "Clipwise records your microphone as one track of the meetings you capture."
set_key NSAudioCaptureUsageDescription string "Clipwise records system audio as the other track of the meetings you capture."
$PB -c "Delete :ElectronAsarIntegrity" "$PLIST" >/dev/null 2>&1 || true
# Points at Resources/Clipwise.icns, copied in above. Was deleted outright until
# SAA-130, because there was nothing to point it at.
set_key CFBundleIconFile        string "$APP_NAME"
$PB -c "Delete :LSApplicationCategoryType" "$PLIST" >/dev/null 2>&1 || true

# --- 3b. fuses ------------------------------------------------------------
#
# Two off (SAA-243, 10-16): another process launching the app with NODE_OPTIONS
# or --inspect would otherwise run its own code with the app's microphone and
# system-audio grants. RunAsNode stays on: the pipeline is the app's own
# executable run as Node (ELECTRON_RUN_AS_NODE, SAA-198). Flipping rewrites the
# Electron Framework binary, so it comes before signing, which seals it. Read
# back rather than trusted: the build fails unless all three read as intended.

step "fuses"
FUSES="$APP_SRC/node_modules/.bin/electron-fuses"
[ -x "$FUSES" ] || { echo "build-app: no $FUSES — run: (cd $APP_SRC && npm install)" >&2; exit 1; }
NO_COLOR=1 "$FUSES" write --app "$APP" EnableNodeOptionsEnvironmentVariable=off EnableNodeCliInspectArguments=off
FUSE_STATE="$(NO_COLOR=1 "$FUSES" read --app "$APP")"
echo "$FUSE_STATE"
for want in "EnableNodeOptionsEnvironmentVariable is Disabled" "EnableNodeCliInspectArguments is Disabled" "RunAsNode is Enabled"; do
    grep -qF "$want" <<<"$FUSE_STATE" || { echo "build-app: fuse read-back is missing: $want" >&2; exit 1; }
done

# --- 4. sign --------------------------------------------------------------
#
# Inside-out, one piece at a time, every piece with the identity, the hardened
# runtime and a secure timestamp: notarization requires all three on every
# executable (SAA-126, SAA-198 engineering call 6). Not --deep: it never reaches
# Resources/bin or Resources/python, which is how the capture binaries stayed
# ad hoc before (SAA-126). Order is innermost first, so each container is sealed
# over pieces that are already signed:
#   1. every Mach-O file under Resources (the capture tools and the Python)
#   2. what is inside each framework, then the framework
#   3. the helper apps
#   4. the app
# Entitlements, only where needed (recorder/app/entitlements/): the app and the
# helpers run V8 (allow-jit), and the app, miccap and systemtap record audio
# (audio-input). Everything else gets none.

ENT="$APP_SRC/entitlements"
sign() {
    # sign <path> [entitlements plist]
    if [ -n "${2:-}" ]; then
        codesign --force --timestamp --options runtime --entitlements "$2" --sign "$IDENTITY" "$1"
    else
        codesign --force --timestamp --options runtime --sign "$IDENTITY" "$1"
    fi
}

step "signing as: $IDENTITY"
SIGNED=0
while IFS= read -r -d '' f; do
    file -b "$f" | grep -q "Mach-O" || continue
    case "$(basename "$f")" in
        miccap|systemtap) sign "$f" "$ENT/capture.plist" ;;
        *) sign "$f" ;;
    esac
    SIGNED=$((SIGNED + 1))
done < <(find "$C/Resources" -type f -print0)
echo "signed $SIGNED Mach-O file(s) under Resources"

FW="$C/Frameworks"
EF="$FW/Electron Framework.framework/Versions/A"
for f in "$EF/Libraries/"*.dylib "$EF/Helpers/chrome_crashpad_handler"; do
    sign "$f"
done
sign "$FW/Electron Framework.framework"
sign "$FW/Squirrel.framework/Versions/A/Resources/ShipIt"
for fw in Squirrel Mantle ReactiveObjC; do
    sign "$FW/$fw.framework"
done
for helper in "$FW/"*Helper*.app; do
    sign "$helper" "$ENT/helper.plist"
done
sign "$APP" "$ENT/app.plist"

step "codesign --verify --deep --strict --verbose=2 $APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# The bundle's Python and pipeline, copied to a plain temporary folder and run
# there as capture-cli runs them (-I -B on transcribe.py). Copied out because
# macOS's App Management can refuse this shell a write inside an .app (it did,
# 10-14), which would hide a write the app's own run makes. With no arguments
# transcribe.py loads its imports and stops at its usage line. The build fails
# if it did not get there, or if any compiled file appeared.
step "the bundle's Python, run as capture-cli runs it, writes no compiled files"
PYCHECK="$(mktemp -d)"
ditto "$C/Resources/python" "$PYCHECK/python"
ditto "$PIPELINE_OUT" "$PYCHECK/pipeline"
PYCHECK_OUT="$("$PYCHECK/python/bin/python3" -I -B "$PYCHECK/pipeline/transcribe.py" 2>&1 || true)"
case "$PYCHECK_OUT" in
    *"usage: transcribe.py"*) ;;
    *) echo "build-app: transcribe.py did not reach its usage line: $PYCHECK_OUT" >&2; rm -rf "$PYCHECK"; exit 1 ;;
esac
if [ -n "$(find "$PYCHECK" \( -name '*.pyc' -o -name __pycache__ \) -print -quit)" ]; then
    echo "build-app: the bundle's Python wrote compiled files when run as capture-cli runs it" >&2; rm -rf "$PYCHECK"; exit 1
fi
rm -rf "$PYCHECK"
echo "no compiled files written"

step "codesign -dvvv $APP"
codesign -dvvv "$APP" 2>&1 | grep -E "^(Identifier|Format|CodeDirectory|CDHash|Signature|Authority|TeamIdentifier|Info\.plist|Sealed Resources|Timestamp)"

printf '\nbuilt %s\n  version %s\n  commit %s%s\n  built_at %s\n' \
    "$APP" "$VERSION" "$COMMIT" "$([ "$DIRTY" = true ] && echo ' (dirty)')" "$BUILT_AT"
