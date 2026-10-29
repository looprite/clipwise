#!/bin/bash
# Packs the zip auto-update installs (SAA-253 decision 3): the notarized,
# stapled app as Clipwise-darwin-arm64-<version>.zip, the asset name
# update.electronjs.org looks for on a GitHub Release. Run by notarize.sh once
# the app's ticket is stapled; the zip holds that same app, so a copy
# installed by an update carries its own ticket.
#
# Refuses, before anything else, a build whose build-info.json does not say
# dirty false (Jon, 2026-10-29): this zip is what every installed copy updates
# to, so it must be a commit that exists. Then refuses a version that differs
# between Info.plist and build-info.json, an app with no stapled ticket, and a
# signature that does not verify.
#
# Usage: release-zip.sh <Clipwise.app> <out dir>. Prints the zip's SHA-256 on
# stderr and its path, alone, on stdout.

set -euo pipefail

APP="${1:?usage: release-zip.sh <Clipwise.app> <out dir>}"
OUT_DIR="${2:?usage: release-zip.sh <Clipwise.app> <out dir>}"
INFO="$APP/Contents/Resources/app/build-info.json"

[ -f "$INFO" ] || { echo "release-zip: no $INFO — not a built app" >&2; exit 1; }

# One field of build-info.json: a bool as true/false, anything else as text,
# missing as empty.
info() {
    /usr/bin/python3 -I -c 'import json,sys
v = json.load(open(sys.argv[1])).get(sys.argv[2])
print(json.dumps(v) if isinstance(v, bool) else ("" if v is None else v))' "$INFO" "$1"
}

DIRTY="$(info dirty)"
COMMIT="$(info commit)"
if [ "$DIRTY" != "false" ]; then
    echo "release-zip: refusing: $APP was built from a dirty tree (commit $COMMIT, dirty=$DIRTY)" >&2
    exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
INFO_VERSION="$(info version)"
if [ -z "$VERSION" ] || [ "$VERSION" != "$INFO_VERSION" ]; then
    echo "release-zip: refusing: Info.plist says version '$VERSION', build-info.json '$INFO_VERSION'" >&2
    exit 1
fi

xcrun stapler validate "$APP" >/dev/null 2>&1 \
    || { echo "release-zip: refusing: $APP carries no stapled ticket — run notarize.sh" >&2; exit 1; }
codesign --verify --deep --strict "$APP" \
    || { echo "release-zip: refusing: $APP does not verify" >&2; exit 1; }

mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/Clipwise-darwin-arm64-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
shasum -a 256 "$ZIP" >&2
echo "$ZIP"
