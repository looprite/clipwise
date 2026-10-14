#!/bin/bash
# Fetches recorder/python/.build/python (SAA-198): the Python that runs
# transcribe.py from inside Clipwise.app, in place of whatever python3 the Mac
# has. A clean Mac may have no usable python3 (unchecked; the bundled copy makes
# it not matter), so the app carries its own (engineering call 4).
#
# A relocatable CPython from python-build-standalone, pinned to a release, an
# asset and that asset's SHA-256 (from the release's SHA256SUMS). The tarball is
# checked before anything is unpacked. transcribe.py imports only the standard
# library, so nothing is installed into it.
#
# Run by build-app.sh. Uses the network once, to fetch the tarball. Python's own
# licence is python/lib/python3.14/LICENSE.txt; THIRD_PARTY_NOTICES carries it.

set -euo pipefail

PY_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$PY_DIR/.build"
OUT="$BUILD/python"

RELEASE="20260924"
ASSET="cpython-3.14.7+$RELEASE-aarch64-apple-darwin-install_only_stripped.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/$RELEASE/$ASSET"
SHA256="f0fb6b233971672dd7add4efa90f8c209a63253e457ffabd0148b9f734638319"
STAMP="$BUILD/.unpacked-$SHA256"

if [ -x "$OUT/bin/python3" ] && [ -f "$STAMP" ]; then
    echo "python: $OUT already unpacked"
    exit 0
fi

for tool in curl shasum tar; do
    command -v "$tool" >/dev/null || { echo "python: $tool not found" >&2; exit 1; }
done

mkdir -p "$BUILD"
if [ ! -f "$BUILD/$ASSET" ]; then
    echo "python: fetching $URL"
    curl -sSfL -o "$BUILD/$ASSET.part" "$URL"
    mv "$BUILD/$ASSET.part" "$BUILD/$ASSET"
fi
if ! (cd "$BUILD" && echo "$SHA256  $ASSET" | shasum -a 256 -c - >/dev/null); then
    echo "python: $ASSET does not match its SHA-256 — removing it" >&2
    rm -f "$BUILD/$ASSET"
    exit 1
fi

rm -rf "$OUT" "$BUILD"/.unpacked-*
tar -xzf "$BUILD/$ASSET" -C "$BUILD"
touch "$STAMP"

echo "python: unpacked $OUT"
"$OUT/bin/python3" -I -c 'import sys; print(sys.version.split()[0], sys.executable)'
