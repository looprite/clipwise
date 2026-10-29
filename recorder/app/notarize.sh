#!/bin/bash
# Notarizes, staples and packs Clipwise.app (SAA-198, engineering call 6), after
# build-app.sh has built and signed it. Produces dist/Clipwise.dmg: a signed,
# notarized and stapled disk image holding the notarized and stapled app, which
# is what is sent as a link (Jon's call 3). Then, through release-zip.sh, the
# zip auto-update installs, dist/Clipwise-darwin-arm64-<version>.zip (SAA-253).
#
# Needs a notarytool keychain profile, made once on the build machine by the
# person who holds the Apple credentials (never by this script):
#   xcrun notarytool store-credentials <profile> --apple-id <id> --team-id 94U8UWWFSL
# and its name in CLIPWISE_NOTARY_PROFILE. No credential is read, printed or
# passed on a command line here; notarytool takes them from the keychain.
#
# Two submissions, the app and then the disk image, so both carry a stapled
# ticket: the app keeps its own once it is copied out of the image.

set -euo pipefail

PROFILE="${CLIPWISE_NOTARY_PROFILE:?set CLIPWISE_NOTARY_PROFILE to the notarytool keychain profile name}"
IDENTITY="${CLIPWISE_SIGN_IDENTITY:-Developer ID Application: Clipwise LLC (94U8UWWFSL)}"

APP_SRC="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$APP_SRC/dist"
APP="$OUT_DIR/Clipwise.app"
ZIP="$OUT_DIR/Clipwise-notarize.zip"
STAGE="$OUT_DIR/dmg-stage"
DMG="$OUT_DIR/Clipwise.dmg"

step() { printf '\n=== %s\n' "$*"; }

# submit <file>: notarize and wait; on anything but Accepted, print Apple's log.
submit() {
    local out id status
    out="$(xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait --output-format json)"
    id="$(printf '%s' "$out" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
    status="$(printf '%s' "$out" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
    echo "notarytool: $(basename "$1") id=$id status=$status"
    if [ "$status" != "Accepted" ]; then
        [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" || true
        echo "notarize: $(basename "$1") was not accepted" >&2
        exit 1
    fi
}

[ -d "$APP" ] || { echo "notarize: no $APP — run build-app.sh first" >&2; exit 1; }

step "verifying the signature before submitting"
codesign --verify --deep --strict --verbose=2 "$APP"

step "notarizing the app"
# A re-run after the disk image's submission failed (SAA-198: an upload cut off by
# the network) does not submit the app again: a ticket already stapled to this
# build is kept. A rebuilt app has no ticket, so it is always submitted.
if xcrun stapler validate "$APP" >/dev/null 2>&1; then
    echo "notarize: $APP already carries a stapled ticket — not submitted again"
else
    rm -f "$ZIP"
    ditto -c -k --keepParent "$APP" "$ZIP"
    submit "$ZIP"
    rm -f "$ZIP"
    xcrun stapler staple "$APP"
fi
xcrun stapler validate "$APP"

step "packing $DMG"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Clipwise.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname Clipwise -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

step "notarizing the disk image"
submit "$DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

step "Gatekeeper"
spctl --assess --type execute --verbose=2 "$APP"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"

# The exact ffmpeg source the app's ffmpeg was built from, beside the .dmg, so it
# is available from the same place as the app (Jon's call 11, SAA-198 step 7;
# THIRD_PARTY_NOTICES says so). ffmpeg/build.sh --source fetches it if needed,
# verifies it against its pinned SHA-256, and prints its path.
step "ffmpeg source beside the disk image"
FFMPEG_SOURCE="$("$APP_SRC/../ffmpeg/build.sh" --source)"
cp "$FFMPEG_SOURCE" "$OUT_DIR/$(basename "$FFMPEG_SOURCE")"
shasum -a 256 "$OUT_DIR/$(basename "$FFMPEG_SOURCE")"

# The zip auto-update installs (SAA-253): the stapled app, named for its
# version. release-zip.sh refuses a build from a dirty tree, so a dirty build
# still gets its .dmg above but this step, and the script, fail.
step "release zip"
RELEASE_ZIP="$("$APP_SRC/release-zip.sh" "$APP" "$OUT_DIR")"

printf '\nnotarized %s\n  and %s\n  with %s beside it\n  release zip %s\n' \
    "$APP" "$DMG" "$(basename "$FFMPEG_SOURCE")" "$(basename "$RELEASE_ZIP")"
