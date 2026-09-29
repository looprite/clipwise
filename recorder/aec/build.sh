#!/bin/bash
# Builds recorder/aec/.build/release/aec (SAA-218): WebRTC AEC3 from the freedesktop
# fork of webrtc-audio-processing, pinned to a tag AND its commit, linked statically
# into a small CLI (aec.cpp). The binary depends only on system frameworks and libc++.
#
# Run by build-app.sh, and by hand once per dev machine.
#
# Needs meson and ninja (`brew install meson ninja`). They are build tools on the
# machine that builds the app, like the Swift toolchain; nothing is installed on
# a user's machine. The build itself uses the network once: git clone of the pinned
# tag, and meson's hash-pinned download of abseil (subprojects/abseil-cpp.wrap).
# The binary it produces never touches the network.
#
# WebRTC is BSD-3 (Google), with a patent grant; abseil is Apache-2.0. Their
# notices are in THIRD_PARTY_NOTICES (repo root).
#
# Not copied into Clipwise.app: the pipeline reads it from the checkout, as it does
# recorder/diarize and recorder/parakeet, and packaging is Phase 4.

set -euo pipefail

AEC_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$AEC_DIR/.build"
SRC="$BUILD/src"
MESON_DIR="$BUILD/meson"
PREFIX="$BUILD/install"
OUT="$BUILD/release/aec"

REPO_URL="https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git"
TAG="v2.1"
COMMIT="846fe90a289f58b7c9303a635142aa2c7caa93e5"

if [ -x "$OUT" ] && [ "$OUT" -nt "$AEC_DIR/aec.cpp" ] && [ "$OUT" -nt "$0" ]; then
    echo "aec: $OUT already built"
    exit 0
fi

for tool in meson ninja clang++ git; do
    command -v "$tool" >/dev/null || { echo "aec: $tool not found — brew install meson ninja (and Xcode command line tools)" >&2; exit 1; }
done

mkdir -p "$BUILD"
if [ ! -d "$SRC/.git" ]; then
    echo "aec: fetching webrtc-audio-processing $TAG"
    git clone -q --depth 1 --branch "$TAG" "$REPO_URL" "$SRC"
fi
GOT="$(git -C "$SRC" rev-parse HEAD)"
if [ "$GOT" != "$COMMIT" ]; then
    echo "aec: $TAG is at $GOT, expected $COMMIT — removing $SRC" >&2
    rm -rf "$SRC"
    exit 1
fi

if [ ! -d "$MESON_DIR" ]; then
    meson setup "$MESON_DIR" "$SRC" --buildtype=release --default-library=static -Dprefix="$PREFIX"
fi
ninja -C "$MESON_DIR"
ninja -C "$MESON_DIR" install

mkdir -p "$(dirname "$OUT")"
ABSL=("$MESON_DIR"/subprojects/abseil-cpp-*/*.a)
clang++ -std=c++17 -O2 \
    -DWEBRTC_LIBRARY_IMPL -DWEBRTC_POSIX \
    -DAEC_LIB_VERSION="\"${TAG#v}\"" -DAEC_LIB_COMMIT="\"$COMMIT\"" \
    -I"$PREFIX/include/webrtc-audio-processing-2" -I"$PREFIX/include" \
    "$AEC_DIR/aec.cpp" -o "$OUT" \
    "$MESON_DIR/webrtc/modules/audio_processing/libwebrtc-audio-processing-2.a" \
    "$MESON_DIR/webrtc/api/liblibapi.a" \
    "$MESON_DIR/webrtc/common_audio/libcommon_audio.a" \
    "$MESON_DIR/webrtc/rtc_base/liblibbase.a" \
    "$MESON_DIR/webrtc/system_wrappers/libsystem_wrappers.a" \
    "$MESON_DIR/webrtc/third_party/rnnoise/liblibrnnoise.a" \
    "$MESON_DIR/webrtc/third_party/pffft/liblibpffft.a" \
    "$MESON_DIR/webrtc/modules/third_party/fft/liblibfft.a" \
    "${ABSL[@]}" \
    -framework CoreFoundation -framework Foundation

echo "aec: built $OUT"
otool -L "$OUT"
