#!/bin/bash
# Populates recorder/parakeet/models/parakeet-tdt-0.6b-v2/ with the FluidAudio
# Core ML conversion of NVIDIA's Parakeet TDT 0.6B v2 (SAA-220, Architecture
# Decision 19). Not committed to git — 443 MB of model weights don't belong in
# the repo. Same shape as ../diarize/fetch-models.sh.
#
# Run by build-app.sh, and by hand once per dev machine. Verifies every file
# against CHECKSUMS.sha256 (checked in, generated from a known-good fetch): a
# mismatch fails loudly and removes the bad directory rather than leaving a
# corrupt fetch where the pipeline will read it.
#
# The models are NOT copied into Clipwise.app. The pipeline reads this checkout
# path, as diarize does, and bundling 443 MB is a packaging decision (Phase 4).
#
# The credit for the model is in THIRD_PARTY_NOTICES (repo root).

set -euo pipefail

PK_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="$PK_DIR/models"
LEAF_DIR="$MODELS_DIR/parakeet-tdt-0.6b-v2"
CHECKSUMS="$MODELS_DIR/CHECKSUMS.sha256"

verify() {
    (cd "$MODELS_DIR" && shasum -a 256 -c "$CHECKSUMS" --status)
}

if [ -d "$LEAF_DIR" ] && verify; then
    echo "fetch-models: $LEAF_DIR already present and verified"
    exit 0
fi

echo "fetch-models: fetching Parakeet TDT 0.6B v2 into $MODELS_DIR"
rm -rf "$LEAF_DIR"

# The one command in the transcription path allowed to touch the network.
swift run --package-path "$PK_DIR" -c release parakeet --fetch-models "$MODELS_DIR"

if ! [ -d "$LEAF_DIR" ]; then
    echo "fetch-models: fetch reported success but $LEAF_DIR is missing" >&2
    exit 1
fi

if ! verify; then
    echo "fetch-models: checksum mismatch after fetch — removing $LEAF_DIR" >&2
    echo "              either CHECKSUMS.sha256 is stale or the download is corrupt." >&2
    rm -rf "$LEAF_DIR"
    exit 1
fi

echo "fetch-models: verified $(find "$LEAF_DIR" -type f | wc -l | tr -d ' ') files against CHECKSUMS.sha256"
