#!/bin/bash
# Builds recorder/ffmpeg/.build/release/ffmpeg (SAA-198): the ffmpeg the capture
# pipeline runs from inside Clipwise.app, in place of whatever ffmpeg is on PATH.
#
# LGPL-only, on purpose (SAA-198, engineering call 5): configure is never given
# --enable-gpl, --enable-nonfree or --enable-version3, and --disable-autodetect
# keeps it from linking anything it finds on the build machine. What is left is
# FFmpeg's own LGPL-2.1-or-later code, linked statically into one binary that
# depends only on system libraries. `ffmpeg -L` on the result says which licence
# it was built under; build-app.sh checks that line.
#
# Only what the pipeline uses is enabled. Its three calls are
#   transcribe.py ffmpeg_downsample_pcm: raw f32le 48 kHz mono → 16 kHz s16 WAV
#   transcribe.py ffmpeg_downsample_wav: miccap's float WAV → 16 kHz s16 WAV
#   voice-clips.ts cutClip: raw f32le 48 kHz mono, -ss/-to → 48 kHz s16 WAV
# so the file protocol, the f32le and WAV demuxers, the WAV muxer, the PCM codecs,
# and the resample, format and trim filters ffmpeg inserts for them.
#
# Run by build-app.sh. Uses the network once, to fetch the pinned release tarball,
# which is checked against its SHA-256 before anything is unpacked. Built in the
# source tree so __FILE__ strings stay relative and no build path ends up in the
# binary.

set -euo pipefail

FF_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$FF_DIR/.build"
OUT="$BUILD/release/ffmpeg"

VERSION="9.0.2"
TARBALL="ffmpeg-$VERSION.tar.xz"
URL="https://ffmpeg.org/releases/$TARBALL"
# The same value Homebrew's ffmpeg formula records for this tarball.
SHA256="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
SRC="$BUILD/ffmpeg-$VERSION"

if [ -x "$OUT" ] && [ "$OUT" -nt "$0" ]; then
    echo "ffmpeg: $OUT already built"
    exit 0
fi

for tool in curl shasum tar make clang; do
    command -v "$tool" >/dev/null || { echo "ffmpeg: $tool not found" >&2; exit 1; }
done

mkdir -p "$BUILD"
if [ ! -f "$BUILD/$TARBALL" ]; then
    echo "ffmpeg: fetching $URL"
    curl -sSfL -o "$BUILD/$TARBALL.part" "$URL"
    mv "$BUILD/$TARBALL.part" "$BUILD/$TARBALL"
fi
if ! (cd "$BUILD" && echo "$SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null); then
    echo "ffmpeg: $TARBALL does not match its SHA-256 — removing it" >&2
    rm -f "$BUILD/$TARBALL"
    exit 1
fi

rm -rf "$SRC"
tar -xJf "$BUILD/$TARBALL" -C "$BUILD"

(
    cd "$SRC"
    ./configure \
        --disable-autodetect \
        --disable-everything \
        --disable-doc \
        --disable-debug \
        --disable-network \
        --disable-ffplay \
        --disable-ffprobe \
        --disable-avdevice \
        --disable-swscale \
        --enable-static \
        --disable-shared \
        --enable-ffmpeg \
        --enable-protocol=file \
        --enable-demuxer=pcm_f32le,wav \
        --enable-muxer=wav \
        --enable-decoder=pcm_f32le,pcm_s16le \
        --enable-encoder=pcm_s16le \
        --enable-filter=aresample,aformat,anull,atrim
    make -j"$(sysctl -n hw.ncpu)" ffmpeg
)

mkdir -p "$(dirname "$OUT")"
cp "$SRC/ffmpeg" "$OUT"

echo "ffmpeg: built $OUT"
"$OUT" -hide_banner -L | head -3
otool -L "$OUT"
