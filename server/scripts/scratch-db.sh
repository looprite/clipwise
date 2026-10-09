#!/usr/bin/env bash
# A throwaway Neon database for the checks that write (check-access, check-auth,
# check-trash). One branch at a time, made schema-only from main, deleted when
# you are done.
#
#   scratch-db.sh up              create scratch-<date>, record its endpoint,
#                                 write its settings to ~/clipwise-eval/scratch/,
#                                 prove the guard, make one admin
#   scratch-db.sh run <check>     check-access | check-auth | check-trash
#   scratch-db.sh down            delete the branch and its files, then read back
#
# Exit codes: 0 ok, 1 a step failed (the branch is left up), 2 refused before
# doing anything, 3 the guard refused a host.
#
# Secrets stay in the settings file (mode 600). Nothing here prints the
# connection string, the admin password, the auth secret or VOYAGE_API_KEY, and
# none of them goes on a command line (where `ps` would show it).
#
# Every check runs from a cleaned environment: only the variables it needs, and
# DOTENV_CONFIG_PATH pointing at an empty file so nothing from server/.env loads
# (src/db/index.ts imports dotenv/config; dotenv honours DOTENV_CONFIG_PATH,
# node_modules/dotenv/lib/env-options.js:8-9).

set -u
set -o pipefail

ORG_ID="${NEON_ORG_ID:-org-fragrant-grass-38449154}"
PROJECT_ID="${NEON_PROJECT_ID:-noisy-river-62261917}"
DB_NAME="${NEON_DATABASE_NAME:-neondb}"
ROLE_NAME="${NEON_ROLE_NAME:-neondb_owner}"
MAIN_BRANCH="main"
ADMIN_EMAIL="scratch-admin@clipwise.test"
# Any origin will do: the checks mount Better Auth in-process on a loopback port.
AUTH_ORIGIN="http://localhost:3000"

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH_DIR="$HOME/clipwise-eval/scratch"

say() { printf '%s\n' "$*"; }
refuse() { say "scratch-db: refused: $*" >&2; exit 2; }
fail() { say "scratch-db: failed: $*" >&2; exit 1; }

# Whatever a tool says on a failure goes through this first.
scrub() { sed -E 's#postgres(ql)?://[^[:space:]"]+#<url>#g; s#npg_[A-Za-z0-9]+#<secret>#g'; }

neon() { neonctl "$@" --project-id "$PROJECT_ID" 2>&1; }

# ---- Node: the version in server/.nvmrc, from Homebrew's keg, for checks only ----

NODE_BIN=""
select_node() {
  local want keg
  want="$(tr -d '[:space:]' < "$SERVER_DIR/.nvmrc")"
  [ -n "$want" ] || refuse "server/.nvmrc is empty"
  keg="/opt/homebrew/opt/node@$want/bin"
  [ -x "$keg/node" ] || refuse "node@$want is not installed. Run: brew install node@$want"
  case "$("$keg/node" -v)" in
    v"$want".*) ;;
    *) refuse "$keg/node is $("$keg/node" -v), not v$want.x. Run: brew install node@$want" ;;
  esac
  NODE_BIN="$keg"
}

# ---- the settings file ----

env_file() { say "$SCRATCH_DIR/$1.env"; }
empty_file() { say "$SCRATCH_DIR/$1.dotenv-empty"; }
# Value of KEY in a settings file. Parsed, not sourced.
envval() { grep -E "^$1=" "$2" | head -n 1 | cut -d= -f2-; }

# ---- what Neon says about main ----

# Main's branch id, read from Neon each time. Fails if it cannot be read.
main_branch_id() {
  local bid
  bid="$(neonctl branches list --project-id "$PROJECT_ID" --output json 2>/dev/null \
    | jq -r --arg n "$MAIN_BRANCH" '.[] | select(.name == $n) | .id')" || return 1
  [ -n "$bid" ] || return 1
  say "$bid"
}

# Endpoint ids on main, one per line. Fails (and prints nothing) if Neon cannot
# be read, so that the guard refuses everything.
main_endpoints() {
  local bid
  bid="$(main_branch_id)" || return 1
  neonctl api "/projects/$PROJECT_ID/endpoints" 2>/dev/null \
    | jq -r --arg b "$bid" '.endpoints[] | select(.branch_id == $b) | "\(.id) \(.host)"'
}

# Waits (bounded) until the project has no operation scheduling, running or
# cancelling. Neon refuses new operations while one is in flight, and a branch
# that was just created has several.
wait_for_idle_project() {
  local i busy
  for i in $(seq 1 30); do
    busy="$(neonctl api "/projects/$PROJECT_ID/operations" -Q limit=50 2>/dev/null \
      | jq -r '[.operations[] | select(.status == "scheduling" or .status == "running" or .status == "cancelling")] | length')"
    [ "$busy" = 0 ] && return 0
    sleep 2
  done
  return 1
}

# ---- the guard ----
# Allows only the recorded scratch endpoint, by endpoint id, so the direct and
# the pooled host of any endpoint (name-pooler) are judged alike. Main's ids are
# read from Neon on every call; if they cannot be, everything is refused.
guard_host() {
  local host label ep mains line id
  host="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [ -n "$host" ] || { say "guard: refused (no host)"; return 3; }
  [ -n "${SCRATCH_ENDPOINT_ID:-}" ] || { say "guard: refused $host (no scratch endpoint recorded)"; return 3; }
  mains="$(main_endpoints)" || mains=""
  [ -n "$mains" ] || { say "guard: refused everything: main's endpoint could not be read from Neon"; return 3; }
  label="${host%%.*}"
  ep="${label%-pooler}"
  while IFS= read -r line; do
    id="${line%% *}"
    if [ "$ep" = "$id" ]; then
      say "guard: REFUSED $label is main's endpoint ($id)"
      return 3
    fi
  done <<EOF
$mains
EOF
  if [ "$ep" != "$SCRATCH_ENDPOINT_ID" ]; then
    say "guard: REFUSED $label is not the recorded scratch endpoint ($SCRATCH_ENDPOINT_ID)"
    return 3
  fi
  say "guard: allowed $label (the recorded scratch endpoint)"
  return 0
}

host_of() { printf '%s' "$1" | sed -E 's#^[a-z]+://[^@]*@([^/:?]+).*#\1#'; }

guard_self_test() {
  local mains line id host pooled rc
  mains="$(main_endpoints)" || mains=""
  [ -n "$mains" ] || { say "guard self-test: cannot read main's endpoint from Neon"; return 1; }
  line="$(printf '%s\n' "$mains" | head -n 1)"
  id="${line%% *}"
  host="${line#* }"
  pooled="$(printf '%s' "$host" | sed -E 's/^([^.]+)\./\1-pooler./')"
  for case_ in "main direct|$host|3" "main pooled|$pooled|3" "scratch|$1|0"; do
    local name="${case_%%|*}" rest="${case_#*|}"
    local h="${rest%%|*}" want="${rest##*|}"
    local out
    out="$(guard_host "$h")"; rc=$?
    say "guard self-test: $name (${h%%.*}) -> exit $rc (expected $want): ${out#guard: }"
    [ "$rc" = "$want" ] || return 1
  done
}

# ---- running node things with a cleaned environment ----
# usage: clean_exec <settings-file> <vars...> -- <command...>
# The variables are read from the settings file (or fixed, below) into this
# subshell's environment and nowhere else; the command inherits only those and
# PATH, HOME, TMPDIR. Nothing goes on a command line.
clean_exec() {
  local f="$1" b
  shift
  b="$(basename "$f" .env)"
  local vars=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  (
    local n v
    for n in $(compgen -e); do
      case "$n" in PATH|HOME|TMPDIR) ;; *) unset "$n" 2>/dev/null ;; esac
    done
    export PATH="$NODE_BIN:$PATH"
    export DOTENV_CONFIG_PATH
    DOTENV_CONFIG_PATH="$(empty_file "$b")"
    # ${vars[@]+...}: an empty array is an unset variable to bash 3.2 under set -u
    for v in ${vars[@]+"${vars[@]}"}; do
      case "$v" in
        CLIPWISE_CHECK_SCRATCH_DB) export CLIPWISE_CHECK_SCRATCH_DB=1 ;;
        AUTH_PASSWORD_ENABLED) export AUTH_PASSWORD_ENABLED=true ;;
        BETTER_AUTH_URL) export BETTER_AUTH_URL="$AUTH_ORIGIN" ;;
        VOYAGE_API_KEY) export VOYAGE_API_KEY="$VOYAGE_VALUE" ;;
        PROBE_HOST) export PROBE_HOST="$PROBE_HOST_VALUE" ;;
        *) export "$v=$(envval "$v" "$f")" ;;
      esac
    done
    cd "$SERVER_DIR" || exit 1
    exec "$@"
  )
}

# ---- the scratch password must not open main ----
# Connects (no query) to main's endpoint with the scratch branch's credentials
# and expects Postgres to refuse the password. Prints only the error class.
PROBE_JS='
(async () => {
  const { parse } = require("pg-connection-string");
  const { Client } = require("pg");
  const cfg = parse(process.env.DATABASE_URL);
  cfg.host = process.env.PROBE_HOST;
  const c = new Client({ ...cfg, connectionTimeoutMillis: 15000 });
  try {
    await c.connect();
    await c.end();
    process.stdout.write("probe: CONNECTED to main with the scratch password\n");
    process.exit(1);
  } catch (e) {
    process.stdout.write(`probe: refused, error class code=${e.code} name=${e.name}\n`);
    process.exit(e.code === "28P01" ? 0 : 1);
  }
})();
'
password_isolation_test() {
  local f="$1" line host
  line="$(main_endpoints | head -n 1)"
  host="${line#* }"
  [ -n "$host" ] || { say "probe: cannot read main's host from Neon"; return 1; }
  PROBE_HOST_VALUE="$host"
  clean_exec "$f" DATABASE_URL PROBE_HOST -- node -e "$PROBE_JS" 2>&1 | scrub
  return "${PIPESTATUS[0]}"
}

# ---- who am I: through src/db/index.ts's own pool ----
WHOAMI_JS='
(async () => {
  const { pool, db, schema } = await import("./src/db/index.js");
  const { sql } = await import("drizzle-orm");
  const r = await pool.query("select current_setting($1, true) as ep, current_database() as db", ["neon.endpoint_id"]);
  const a = await db.select({ n: sql`count(*)::int` }).from(schema.accounts);
  const m = await db.select({ n: sql`count(*)::int` }).from(schema.accountMembers);
  const ep = r.rows[0].ep;
  process.stdout.write(`who am I: endpoint=${ep} database=${r.rows[0].db} accounts=${a[0].n} members=${m[0].n}\n`);
  await pool.end();
  if (ep !== process.env.SCRATCH_ENDPOINT_ID) {
    process.stderr.write(`who am I: the endpoint reached is not the recorded scratch endpoint (${process.env.SCRATCH_ENDPOINT_ID})\n`);
    process.exit(3);
  }
})().catch((e) => {
  process.stderr.write(`who am I: failed: ${String(e && e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")}\n`);
  process.exit(1);
});
'

who_am_i() {
  local f="$1" tries=0 rc
  while [ "$tries" -lt 4 ]; do
    clean_exec "$f" DATABASE_URL SCRATCH_ENDPOINT_ID -- npx --no-install tsx -e "$WHOAMI_JS" 2>&1 | scrub
    rc=${PIPESTATUS[0]}
    # 0 ok; 3 the wrong endpoint (never retry that)
    [ "$rc" = 0 ] || [ "$rc" = 3 ] && return "$rc"
    tries=$((tries + 1))
    sleep 3
  done
  return 1
}

# ---- commands ----

list_scratch_branches() {
  neonctl branches list --project-id "$PROJECT_ID" --output json 2>/dev/null \
    | jq -r '.[] | select(.name | startswith("scratch-")) | .name'
}

cmd_up() {
  command -v neonctl >/dev/null || refuse "neonctl is not installed"
  command -v jq >/dev/null || refuse "jq is not installed"
  command -v openssl >/dev/null || refuse "openssl is not installed"
  select_node
  [ -d "$SERVER_DIR/node_modules" ] || refuse "server/node_modules is missing. Run: (cd server && PATH=$NODE_BIN:\$PATH npm ci)"

  local existing
  existing="$(list_scratch_branches)" || fail "could not list branches"
  if [ -n "$existing" ]; then
    refuse "a scratch branch already exists: $(printf '%s' "$existing" | tr '\n' ' ')- run: scratch-db.sh down"
  fi
  main_endpoints >/dev/null || refuse "main's endpoint cannot be read from Neon"

  local branch f e out bid ep suspend mainbid ops op i st
  branch="scratch-$(date +%Y-%m-%d)"
  f="$(env_file "$branch")"
  e="$(empty_file "$branch")"

  mkdir -p -m 700 "$SCRATCH_DIR" && chmod 700 "$SCRATCH_DIR" || fail "cannot make $SCRATCH_DIR"
  umask 077

  say "up: creating $branch (schema-only from $MAIN_BRANCH, suspend after 3600 s)"
  out="$(neonctl branches create --project-id "$PROJECT_ID" --name "$branch" --parent "$MAIN_BRANCH" \
    --schema-only --suspend-timeout=3600 --output json 2>&1)" \
    || { say "$out" | scrub >&2; fail "branch create failed"; }
  bid="$(printf '%s' "$out" | jq -r '.branch.id')"
  out=""
  [ -n "$bid" ] && [ "$bid" != null ] || fail "branch created but its id could not be read; check Neon for $branch"

  ep="$(neonctl api "/projects/$PROJECT_ID/endpoints" 2>/dev/null \
    | jq -r --arg b "$bid" '.endpoints[] | select(.branch_id == $b and .type == "read_write") | .id')"
  [ -n "$ep" ] || fail "no read-write endpoint on $branch ($bid); the branch is left up"
  say "up: scratch endpoint $ep, branch $bid"

  # The scratch branch gets its own password for the role. Roles are branch-scoped
  # in Neon, so this resets it on this branch only; main's stays as it was.
  mainbid="$(main_branch_id)" || refuse "main's branch id cannot be read from Neon; the branch $branch is left up"
  [ "$bid" != "$mainbid" ] || refuse "the scratch branch id equals main's; not resetting any password"
  wait_for_idle_project || fail "the project still has running operations after 60 s; the branch is left up"
  # A conflicting operation can still start between the wait and the call, so
  # retry on that error (5 attempts, 5 s apart) and on nothing else.
  local attempt=0
  while :; do
    attempt=$((attempt + 1))
    out="$(neonctl api -X POST "/projects/$PROJECT_ID/branches/$bid/roles/$ROLE_NAME/reset_password" 2>&1)" && break
    case "$out" in
      *"conflicting operations"*)
        [ "$attempt" -lt 5 ] || { say "$out" | scrub >&2; fail "password reset still conflicting after $attempt attempts; the branch is left up"; }
        say "up: reset refused (conflicting operations), attempt $attempt of 5; waiting"
        sleep 5
        wait_for_idle_project || true
        ;;
      *) say "$out" | scrub >&2; fail "password reset failed; the branch is left up" ;;
    esac
  done
  say "up: password reset accepted on attempt $attempt"
  ops="$(printf '%s' "$out" | jq -r '.operations[]?.id')"
  out=""
  for op in $ops; do
    st=""
    for i in $(seq 1 30); do
      st="$(neonctl api "/projects/$PROJECT_ID/operations/$op" 2>/dev/null | jq -r '.operation.status')"
      [ "$st" = finished ] && break
      sleep 2
    done
    [ "$st" = finished ] || fail "password reset operation $op is $st; the branch is left up"
  done
  say "up: $ROLE_NAME's password reset on branch $bid only (main is $mainbid)"

  suspend="$(neonctl api "/projects/$PROJECT_ID/endpoints/$ep" 2>/dev/null | jq -r '.endpoint.suspend_timeout_seconds')"
  say "up: read back from Neon: endpoint $ep suspend_timeout_seconds=$suspend"
  [ "$suspend" = "3600" ] || fail "the endpoint's suspend timeout is not 3600; the branch is left up"

  : > "$e"
  printf 'DATABASE_URL=' > "$f"
  neonctl connection-string "$branch" --project-id "$PROJECT_ID" --database-name "$DB_NAME" \
    --role-name "$ROLE_NAME" --ssl verify-full >> "$f" 2>/dev/null \
    || fail "could not write the connection string; the branch is left up"
  {
    printf 'SCRATCH_BRANCH=%s\n' "$branch"
    printf 'SCRATCH_BRANCH_ID=%s\n' "$bid"
    printf 'SCRATCH_ENDPOINT_ID=%s\n' "$ep"
    printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')"
    printf 'SCRATCH_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL"
    printf 'SCRATCH_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9')"
  } >> "$f"
  chmod 600 "$f" "$e"
  say "up: settings written to $f (mode $(stat -f %Lp "$f"), folder mode $(stat -f %Lp "$SCRATCH_DIR")); sslmode=verify-full lines: $(grep -c 'sslmode=verify-full' "$f")"

  SCRATCH_ENDPOINT_ID="$ep"
  local url host
  url="$(envval DATABASE_URL "$f")"
  host="$(host_of "$url")"
  url=""
  guard_self_test "$host" || fail "the guard self-test did not pass; the branch is left up"
  say "up: control: the scratch password against main's endpoint (connect only, no query)"
  password_isolation_test "$f" || fail "the scratch password was not refused by main; the branch is left up"

  who_am_i "$f" || fail "who am I failed; the branch is left up"
  say "up: expected from the code: init-account makes the one account, bootstrap-admin adds one member and its login"
  clean_exec "$f" DATABASE_URL BETTER_AUTH_SECRET BETTER_AUTH_URL AUTH_PASSWORD_ENABLED SCRATCH_ADMIN_PASSWORD -- \
    npx --no-install tsx src/auth/cli.ts init-account --name Scratch 2>&1 | scrub
  [ "${PIPESTATUS[0]}" = 0 ] || fail "init-account failed; the branch is left up"
  clean_exec "$f" DATABASE_URL BETTER_AUTH_SECRET BETTER_AUTH_URL AUTH_PASSWORD_ENABLED SCRATCH_ADMIN_PASSWORD -- \
    npx --no-install tsx src/auth/cli.ts bootstrap-admin --email "$ADMIN_EMAIL" --name "Scratch admin" \
    --password-env SCRATCH_ADMIN_PASSWORD 2>&1 | scrub
  [ "${PIPESTATUS[0]}" = 0 ] || fail "bootstrap-admin failed; the branch is left up"
  who_am_i "$f" || fail "who am I failed; the branch is left up"
  say "up: done. Next: scratch-db.sh run check-access | check-auth | check-trash"
}

# The one settings file there is, or a refusal.
only_env_file() {
  local files n
  files="$(ls "$SCRATCH_DIR"/scratch-*.env 2>/dev/null)"
  n="$(printf '%s' "$files" | grep -c . )"
  [ "$n" = 1 ] || refuse "expected one settings file in $SCRATCH_DIR, found $n. Run: scratch-db.sh up"
  printf '%s' "$files"
}

cmd_run() {
  local check="${1:-}" script f b
  case "$check" in
    check-access) script="src/access/check-access.ts" ;;
    check-auth) script="src/auth/check-auth.ts" ;;
    check-trash) script="src/pipeline/check-trash.ts" ;;
    *) refuse "usage: scratch-db.sh run check-access|check-auth|check-trash" ;;
  esac
  command -v neonctl >/dev/null || refuse "neonctl is not installed"
  command -v jq >/dev/null || refuse "jq is not installed"
  select_node
  f="$(only_env_file)" || exit $?
  b="$(basename "$f" .env)"
  [ -f "$(empty_file "$b")" ] || { : > "$(empty_file "$b")"; chmod 600 "$(empty_file "$b")"; }

  SCRATCH_ENDPOINT_ID="$(envval SCRATCH_ENDPOINT_ID "$f")"
  local url host
  url="$(envval DATABASE_URL "$f")"
  host="$(host_of "$url")"
  url=""
  guard_host "$host" || exit 3
  # What the child will see, not what the keg says.
  local seen want
  want="$(tr -d '[:space:]' < "$SERVER_DIR/.nvmrc")"
  seen="$(clean_exec "$f" -- node -v)"
  say "run: node -v as the check will see it: $seen"
  case "$seen" in v"$want".*) ;; *) refuse "node is $seen, not v$want.x" ;; esac
  who_am_i "$f" || exit $?

  say "run: $check"
  case "$check" in
    check-trash)
      # The one process that gets VOYAGE_API_KEY, read from the real server/.env.
      local real_env v
      real_env="${CLIPWISE_SERVER_ENV:-$(git -C "$SERVER_DIR" worktree list --porcelain | sed -n '1s/^worktree //p')/server/.env}"
      [ -f "$real_env" ] || refuse "no server/.env to read VOYAGE_API_KEY from ($real_env)"
      v="$(envval VOYAGE_API_KEY "$real_env")"
      v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
      [ -n "$v" ] || refuse "VOYAGE_API_KEY is not set in $real_env"
      VOYAGE_VALUE="$v"
      v=""
      clean_exec "$f" DATABASE_URL VOYAGE_API_KEY -- npx --no-install tsx "$script" 2>&1 | scrub
      exit "${PIPESTATUS[0]}"
      ;;
    *)
      clean_exec "$f" DATABASE_URL CLIPWISE_CHECK_SCRATCH_DB BETTER_AUTH_SECRET BETTER_AUTH_URL AUTH_PASSWORD_ENABLED -- \
        npx --no-install tsx "$script" 2>&1 | scrub
      exit "${PIPESTATUS[0]}"
      ;;
  esac
}

cmd_down() {
  command -v neonctl >/dev/null || refuse "neonctl is not installed"
  command -v jq >/dev/null || refuse "jq is not installed"
  local names n branch out
  names="$(list_scratch_branches)" || fail "could not list branches"
  n="$(printf '%s' "$names" | grep -c . )"
  [ "$n" = 1 ] || refuse "expected exactly one scratch-* branch, found $n"
  branch="$names"
  case "$branch" in scratch-*) ;; *) refuse "not a scratch branch: $branch" ;; esac

  say "down: deleting $branch"
  out="$(neonctl branches delete "$branch" --project-id "$PROJECT_ID" 2>&1)" || { say "$out" | scrub >&2; fail "branch delete failed"; }
  rm -f "$(env_file "$branch")" "$(empty_file "$branch")"

  say "down: read back (separate commands)"
  say "branches:"
  neonctl branches list --project-id "$PROJECT_ID" --output json | jq -r '.[].name'
  say "ls $SCRATCH_DIR:"
  ls -A "$SCRATCH_DIR"
  say "(end of listing)"
}

case "${1:-}" in
  up) cmd_up ;;
  run) shift; cmd_run "$@" ;;
  down) cmd_down ;;
  *) say "usage: scratch-db.sh up | run <check-access|check-auth|check-trash> | down" >&2; exit 2 ;;
esac
