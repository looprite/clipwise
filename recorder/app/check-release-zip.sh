#!/bin/bash
# Checks release-zip.sh (SAA-253): it refuses a build from a dirty tree, and
# packs a clean one into the zip auto-update installs.
#
# Usage: check-release-zip.sh <Clipwise.app> <scratch dir>
#   <Clipwise.app>  a build from a clean tree, notarized and stapled
#                   (build-app.sh then notarize.sh)
#   <scratch dir>   emptied and reused; nothing is written anywhere else
#
# Two copies of the same app. The dirty one differs only in build-info.json's
# dirty field, the one field the refusal reads, so a refusal there that names
# the dirty tree is that refusal and not some other one. The clean copy is the
# positive control: same app, same script, a zip.
#
# Exit 0 when every case matches its expectation, 1 otherwise.

set -uo pipefail

SRC="${1:?usage: check-release-zip.sh <Clipwise.app> <scratch dir>}"
WORK="${2:?usage: check-release-zip.sh <Clipwise.app> <scratch dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/release-zip.sh"

fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }

rm -rf "$WORK"
mkdir -p "$WORK/dirty" "$WORK/clean" "$WORK/out-dirty" "$WORK/out-clean" "$WORK/unzipped"
ditto "$SRC" "$WORK/clean/Clipwise.app"
ditto "$SRC" "$WORK/dirty/Clipwise.app"

field() {
    /usr/bin/python3 -I -c 'import json,sys
v = json.load(open(sys.argv[1])).get(sys.argv[2])
print(json.dumps(v) if isinstance(v, bool) else ("" if v is None else v))' "$1/Contents/Resources/app/build-info.json" "$2"
}

# Precondition: the app given is a clean build.
if [ "$(field "$WORK/clean/Clipwise.app" dirty)" = "false" ]; then
    pass "precondition: $SRC says dirty false"
else
    fail "precondition: $SRC does not say dirty false — build from a clean tree"
fi
VERSION="$(field "$WORK/clean/Clipwise.app" version)"

# The dirty copy: dirty set to true, nothing else touched.
/usr/bin/python3 -I -c 'import json,sys
p = sys.argv[1]
d = json.load(open(p))
d["dirty"] = True
open(p, "w").write(json.dumps(d, indent=2) + "\n")' "$WORK/dirty/Clipwise.app/Contents/Resources/app/build-info.json"
[ "$(field "$WORK/dirty/Clipwise.app" dirty)" = "true" ] && pass "dirty copy says dirty true" || fail "dirty copy not marked"

# --- dirty: refused, says why, no zip -----------------------------------------
"$SCRIPT" "$WORK/dirty/Clipwise.app" "$WORK/out-dirty" > "$WORK/dirty.out" 2> "$WORK/dirty.err"
rc=$?
echo "      dirty: exit=$rc  stderr: $(cat "$WORK/dirty.err")"
[ "$rc" -ne 0 ] && pass "dirty: non-zero exit" || fail "dirty: exit 0"
grep -q "refusing: .* dirty tree" "$WORK/dirty.err" && pass "dirty: refusal names the dirty tree" || fail "dirty: refusal does not name the dirty tree"
[ -z "$(ls -A "$WORK/out-dirty")" ] && pass "dirty: no zip written" || fail "dirty: wrote $(ls -A "$WORK/out-dirty")"

# --- clean: one zip, named for the version, holding a stapled, verifying app ---
"$SCRIPT" "$WORK/clean/Clipwise.app" "$WORK/out-clean" > "$WORK/clean.out" 2> "$WORK/clean.err"
rc=$?
echo "      clean: exit=$rc  stdout: $(cat "$WORK/clean.out")  stderr: $(cat "$WORK/clean.err")"
[ "$rc" -eq 0 ] && pass "clean: exit 0" || fail "clean: exit $rc"
EXPECT="$WORK/out-clean/Clipwise-darwin-arm64-$VERSION.zip"
[ "$(ls -A "$WORK/out-clean")" = "Clipwise-darwin-arm64-$VERSION.zip" ] \
    && pass "clean: exactly one zip, Clipwise-darwin-arm64-$VERSION.zip" \
    || fail "clean: out dir holds '$(ls -A "$WORK/out-clean")'"
[ "$(cat "$WORK/clean.out")" = "$EXPECT" ] && pass "clean: stdout is the zip's path" || fail "clean: stdout is not the zip's path"
if [ -f "$EXPECT" ] && ditto -x -k "$EXPECT" "$WORK/unzipped"; then
    xcrun stapler validate "$WORK/unzipped/Clipwise.app" >/dev/null 2>&1 \
        && pass "clean: unzipped app carries its stapled ticket" || fail "clean: unzipped app has no stapled ticket"
    codesign --verify --deep --strict "$WORK/unzipped/Clipwise.app" 2>/dev/null \
        && pass "clean: unzipped app verifies" || fail "clean: unzipped app does not verify"
else
    fail "clean: zip missing or does not unpack"
fi

echo
[ "$fails" -eq 0 ] && echo "all cases as expected" || echo "$fails case(s) not as expected"
[ "$fails" -eq 0 ]
