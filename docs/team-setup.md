# Setting up a team's Clipwise instance

This guide builds one team's Clipwise server from nothing: a Fly app, a Neon database, a Google sign-in client, a web address, and the team's own keys. It's written for whoever builds the instance. Today that's Looprite, for each team it hosts. It's also meant to work for a team hosting its own.

Each team gets its own instance. Nothing is shared between instances: not the database, the keys or the address. The team's admin then runs their team from the Mac app ([admin-guide.md](admin-guide.md)) and never needs the server or the database. Whoever built the instance keeps operator access (Fly, Neon, the admin commands) for setup and support.

Every step ends with a check. Don't start the next step until the check reads as shown. Section 19 lists every check in one place.

**Secrets.** Nothing secret goes in a file, a chat, the repo or a command line. Each secret is generated or pasted into a shell variable with `read -s`, saved in your password manager, and passed to Fly through `fly secrets import`, which reads it from standard input. Run these steps in zsh, which has `printf` and `read -s "NAME?prompt"` built in.

## 1. Before you start

You need:

- accounts with Fly.io, Neon, Google Cloud, Anthropic, Voyage AI, and the DNS provider for your domain (Looprite uses Cloudflare);
- a password manager;
- on your Mac: `git`, `flyctl` (`fly`), `neonctl`, `psql`, `jq`, `python3`, and Node 22;
- a copy of this repository.

Work from a fresh git worktree at `main`, not from a folder where anything else runs. Remove the branch's upstream, so the worktree can never push to `main`:

```zsh
git fetch origin main
git worktree add -b <team>-instance ~/code/clipwise-<team> origin/main
git -C ~/code/clipwise-<team> branch --unset-upstream <team>-instance
cd ~/code/clipwise-<team>/server
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node -v                      # expect v22.x
npm ci                       # expect exit 0
git status --porcelain       # expect nothing
```

**Check:** `node -v` prints v22, `npm ci` exits 0, and `git status --porcelain` prints nothing.

## 2. Choose the names

Write these down before you start. The rest of this guide uses them as placeholders:

| Placeholder | What it is | Example form |
|---|---|---|
| `<team>` | A short name for the team, used in file and key names | lowercase, no spaces |
| `<app>` | The Fly app name | `clipwise-<team>` |
| `<subdomain>` | The instance's host name under clipwiseapp.com. The team's address is `https://<subdomain>.clipwiseapp.com`. A team hosting its own uses its own host name in place of `<subdomain>.clipwiseapp.com` throughout. | |
| `<domain>` | The team's email domain. Only addresses on it can sign in. | |
| `<admin email>` | The team admin's work email, on `<domain>` | |

[CHECK: the names for the next team (`<team>`, `<app>`, `<subdomain>`, the account name and slug). Jon decides them before the build.]

## 3. The Fly app

```zsh
fly orgs list                           # find your organization's slug
fly apps list                           # check <app> isn't taken
fly apps create <app> -o <fly org>
fly machines list -a <app>
```

**Check:** `fly apps create` prints `New app created: <app>`, and `fly machines list` prints `No machines are available on this app <app>`.

From here on, every `fly` command names `-a <app>`. Never run one without it.

## 4. The team's keys

Each instance has its own keys. Never reuse another instance's.

1. **Voyage AI.** In the Voyage dashboard, first check that data use reads **Opted Out**. Then create an API key named `clipwise-<team>` and save it in your password manager.
2. **Anthropic.** In the Anthropic console, create an API key named `clipwise-<team>`. Note its expiry date, and save it in your password manager.
3. **The call-text key (`CALL_TEXT_KEY`).** It encrypts every call's text on the server. Losing it loses all of the team's call text, so the password-manager copy is its only backup. Make it like this. The key goes straight to the clipboard and is never shown:

   ```zsh
   K0=$(openssl rand -base64 32)
   printf %s "$K0" | pbcopy          # paste into a new password-manager entry and save it
   printf '' | pbcopy                # clear the clipboard
   read -s "K1?Paste the key from the password manager: "; echo
   read -s "K2?Paste it again: "; echo
   [ -n "$K0" ] && [ "$K0" = "$K1" ] && [ "$K1" = "$K2" ] && echo same || echo DIFFERENT
   printf %s "$K1" | base64 -d | wc -c                        # expect 32
   printf %s "$K1" | base64 -d | shasum -a 256 | cut -c1-8    # the key's id, for section 5
   unset K0 K1 K2
   ```

   **Check:** `same`, then `32`, then an 8-character id. The id isn't secret. Write it down as `<key id>`, and check it differs from every other instance's.

`BETTER_AUTH_SECRET` is made in section 9 and `CALENDAR_TOKEN_ENCRYPTION_KEY` in section 11, each new for this instance.

[CHECK: whether each team gets its own Anthropic and Voyage keys, and who pays for them. Jon decides.]

## 5. The team's Fly config file

The team's config file lives **outside the repository**, in your own folder (for example `~/clipwise-teams/<team>/fly.<team>.toml`). It never goes in the repo. Start from the repo's `server/fly.toml` and copy it there:

```zsh
mkdir -p ~/clipwise-teams/<team>
cp fly.toml ~/clipwise-teams/<team>/fly.<team>.toml
```

In the copy, change these lines and leave everything else as it is:

| Key | Value |
|---|---|
| `app` | `"<app>"` |
| `BETTER_AUTH_URL` | `"https://<subdomain>.clipwiseapp.com"` (no trailing slash) |
| `AUTH_ALLOWED_EMAIL_DOMAIN` | `"<domain>"` |
| `AUTH_PASSWORD_ENABLED` | `"false"` |
| `CALL_TEXT_KEY_ID` | `"<key id>"` from section 4 |

Also correct the comments above those lines that name another team's domain or key id.

**Check:** `diff fly.toml ~/clipwise-teams/<team>/fly.<team>.toml` shows only those lines and their comments.

## 6. The Neon project

```zsh
neonctl orgs list
neonctl projects list                    # check no project named clipwise-<team>
neonctl projects create --name clipwise-<team> --org-id <neon org id> --region-id aws-us-west-2 --pg-version 17
```

The region is AWS us-west-2, next to Fly's `sjc` region (`fly.toml`'s `primary_region`). `neonctl`'s create output doesn't show the branch, database and role, so read them back:

```zsh
neonctl projects list
neonctl branches list --project-id <neon project id>
neonctl databases list --project-id <neon project id>
neonctl roles list --project-id <neon project id>
```

**Check:** one branch, `main`, ready. One database, `neondb`, owned by `neondb_owner`. One role, `neondb_owner`.

**The owner's connection string.** Copy it from the Neon console for this project, role `neondb_owner`, with **connection pooling off** (the direct host, with no `-pooler` in it). Save it in your password manager. Then edit it:

- change `sslmode=require` to `sslmode=verify-full`;
- remove `&channel_binding=require` if it's there.

Nothing in this guide ever prints it.

## 7. Check the database is empty

`db:provision` (section 9) only works on an empty database. In the Neon console's SQL editor, on `neondb`, as the owner:

```sql
select count(*) from information_schema.tables where table_schema = 'public';
select count(*) from pg_extension where extname = 'vector';
```

**Check:** both are `0`.

## 8. The server's restricted login

The server doesn't connect as the owner. It uses its own login, `clipwise_server`, which can read and write rows and nothing else. Make the login in `psql` as the owner. The password is typed at a `\prompt`, so it never appears in a command or a file. Neon refuses `\password`.

First generate the password and save it in your password manager as the `clipwise_server` password. Then:

```zsh
read -s "DATABASE_URL?Paste the neondb_owner DIRECT connection string: "; echo
PGSSLROOTCERT=system psql "$DATABASE_URL" -X
```

In `psql`:

```
CREATE ROLE clipwise_server LOGIN;
\prompt 'clipwise_server password: ' pw
ALTER ROLE clipwise_server PASSWORD :'pw';
\unset pw
\du clipwise_server
\q
```

Turn `psql`'s history off for this session. [CHECK: how history was turned off on 11-19 isn't recorded, and nobody has checked whether `\prompt` shows what you paste. Settle both on the next build, and write the exact lines here.]

**Check:** `\du clipwise_server` shows the role with no attributes (no Superuser, Create role, Create DB, Replication or Bypass RLS).

Keep this Terminal window open: section 9 uses `DATABASE_URL`.

## 9. Build the database

Same Terminal window, in `server/`. First make `BETTER_AUTH_SECRET`. Provisioning uses it, and Fly must get **the same value** in section 11. Never change `BETTER_AUTH_SECRET` once the instance has run. It's bound to the server's stored signing key (decided on the second-user issue, 09-30), so changing it isn't supported.

```zsh
S0=$(openssl rand -base64 32)
printf %s "$S0" | pbcopy                  # paste into a new password-manager entry and save it
printf '' | pbcopy                        # clear the clipboard
read -s "BETTER_AUTH_SECRET?Paste BETTER_AUTH_SECRET from the password manager: "; echo
[ -n "$S0" ] && [ "$S0" = "$BETTER_AUTH_SECRET" ] && echo same || echo DIFFERENT
printf %s "$BETTER_AUTH_SECRET" | wc -c   # expect 44
unset S0

print -r -- "$DATABASE_URL" | sed -E 's#//[^@]*@#//***@#'   # host has no -pooler, database neondb, sslmode=verify-full
export BETTER_AUTH_SECRET DATABASE_URL
export BETTER_AUTH_URL=https://<subdomain>.clipwiseapp.com

npm run db:provision > ~/clipwise-teams/<team>/provision.txt 2>&1; echo "exit=$?"
grep -cE 'postgres(ql)?://' ~/clipwise-teams/<team>/provision.txt     # expect 0
grep -ciE '\bdrop\b' ~/clipwise-teams/<team>/provision.txt            # expect 0
```

`db:provision` refuses a database that already has tables. The `DATABASE_URL` you export takes precedence over any `.env` file.

**Check.** The `db-provision:` lines, in this order, then `exit=0`:

```
db-provision: pgvector ready
  (drizzle-kit push: 16 CREATE TABLE, their indexes, foreign keys and 9 CHECKs; no DROP; "Changes applied")
db-provision: tables pushed
db-provision: checks: 9 present, 0 added
db-provision: auth tables created
db-provision: auth initialised
db-provision: done: 28 tables in public
```

The 16 tables are `account_members accounts attendees calendar_connections clips invitees jobs moments notice_acknowledgements people recordings refresh_token_recoveries segments shares speakers transcripts`.

**An expected error.** Between `checks:` and `auth tables created`, Better Auth may print `ERROR [Better Auth]: Database schema mismatch`, followed by a list of missing tables and `help: Run npx auth migrate`. Treat it as harmless only if all of these hold:

- it lists missing auth tables only;
- it comes before `auth tables created`;
- the run still ends with `auth initialised`, `done: 28 tables in public` and `exit=0`.

If any of these doesn't hold, stop.

[CHECK: these lines and the count of 28 were recorded at commit 4cf9306. Better Auth was upgraded after that (to 1.7.16). Settle on the next build, or on a scratch provision from a worktree, and update the expected lines.]

## 10. Give the server login its rights

Same window, still with the owner's `DATABASE_URL`:

```zsh
npm run db:grant-server-login -- clipwise_server --dry
npm run db:grant-server-login -- clipwise_server
```

**Check.** `--dry` prints `owner neondb_owner, login clipwise_server, 28 relation(s) in public`, then six `would run:` lines:

```
REVOKE ALL ON SCHEMA public FROM "clipwise_server"
GRANT USAGE ON SCHEMA public TO "clipwise_server"
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "clipwise_server"
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "clipwise_server"
ALTER DEFAULT PRIVILEGES FOR ROLE "neondb_owner" IN SCHEMA public REVOKE ALL ON TABLES FROM "clipwise_server"
ALTER DEFAULT PRIVILEGES FOR ROLE "neondb_owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "clipwise_server"
```

The real run prints `BEGIN`, the same six statements, then `COMMIT`.

**Check by logging in as the login.** Use the direct host from the owner string. Everything changed here is rolled back:

```zsh
read -s "PGPASSWORD?clipwise_server password: "; echo; export PGPASSWORD
PGSSLROOTCERT=system psql "host=<direct host> dbname=neondb user=clipwise_server sslmode=verify-full" -X -v ON_ERROR_STOP=0 <<'SQL'
select current_user, session_user;
begin; insert into accounts (name, slug) values ('check', 'check'); rollback;
select count(*) as accounts_after from accounts;
truncate recordings;
create table should_fail (id int);
alter table recordings add column should_fail int;
SQL
unset PGPASSWORD DATABASE_URL
```

Expect: `clipwise_server | clipwise_server`, `INSERT 0 1` then `ROLLBACK`, `accounts_after` `0`, and three refusals: `permission denied for table recordings`, `permission denied for schema public`, `must be owner of table recordings`.

The owner's connection string is no longer needed. `unset` removed it from this window.

## 11. The server's secrets

The server uses the **direct** host too, as `clipwise_server`. Every value is pasted at a `read -s` prompt from the password manager. The database password is URL-encoded by Node, which reads it from its environment, because characters like `@ : / ? #` would break the URL.

```zsh
# CALENDAR_TOKEN_ENCRYPTION_KEY, new: straight to the clipboard, never on screen
C0=$(openssl rand -base64 32)
printf %s "$C0" | pbcopy        # paste into a new password-manager entry and save it
printf '' | pbcopy              # clear the clipboard
read -s "CAL?Paste CALENDAR_TOKEN_ENCRYPTION_KEY from the password manager: "; echo
[ -n "$C0" ] && [ "$C0" = "$CAL" ] && echo same || echo DIFFERENT
printf %s "$CAL" | base64 -d | wc -c        # expect 32
unset C0

read -s "BETTER_AUTH_SECRET?BETTER_AUTH_SECRET (the same as section 9): "; echo
read -s "ANT?ANTHROPIC_API_KEY: "; echo
read -s "VOY?VOYAGE_API_KEY: "; echo
read -s "GCS?GOOGLE_CLIENT_SECRET: "; echo
read -s "CTK?CALL_TEXT_KEY: "; echo
read    "GCI?GOOGLE_CLIENT_ID (not secret): "
read -s "PW?clipwise_server password: "; echo

H=<direct host>
PWE=$(P="$PW" node -e 'process.stdout.write(encodeURIComponent(process.env.P))')
DBU="postgresql://clipwise_server:${PWE}@${H}/neondb?sslmode=verify-full"
unset PW PWE

# Checks before anything goes to Fly
for v in DBU BETTER_AUTH_SECRET CTK ANT VOY GCI GCS CAL; do printf '%s length %s\n' $v ${#${(P)v}}; done   # each non-zero
printf %s "$CTK" | base64 -d | shasum -a 256 | cut -c1-8     # expect <key id>
printf %s "$BETTER_AUTH_SECRET" | wc -c                       # expect 44
print -r -- "$DBU" | sed -E 's#//([^:]*):[^@]*@#//\1:***@#'   # expect postgresql://clipwise_server:***@<direct host>/neondb?sslmode=verify-full
PGSSLROOTCERT=system psql "$DBU" -X -A -t -c 'select current_user'   # expect clipwise_server
```

If any check isn't as expected, stop here. Otherwise stage the nine secrets:

```zsh
{
  printf 'DATABASE_URL=%s\n' "$DBU"
  printf 'BETTER_AUTH_SECRET=%s\n' "$BETTER_AUTH_SECRET"
  printf 'CALL_TEXT_KEY=%s\n' "$CTK"
  printf 'ANTHROPIC_API_KEY=%s\n' "$ANT"
  printf 'VOYAGE_API_KEY=%s\n' "$VOY"
  printf 'GOOGLE_CLIENT_ID=%s\n' "$GCI"
  printf 'GOOGLE_CLIENT_SECRET=%s\n' "$GCS"
  printf 'GOOGLE_OAUTH_REDIRECT_URI=%s\n' 'https://<subdomain>.clipwiseapp.com/oauth/google/callback'
  printf 'CALENDAR_TOKEN_ENCRYPTION_KEY=%s\n' "$CAL"
} | fly secrets import --stage -a <app>; echo "exit=${pipestatus[*]}"     # expect exit=0 0
unset DBU BETTER_AUTH_SECRET CTK ANT VOY GCI GCS CAL H
```

The Google client id and secret come from section 15. You can stage those two after section 15 instead, using the same `printf … | fly secrets import --stage` form.

**Check:** `fly secrets list -a <app>` shows these nine names, each `Staged`: `ANTHROPIC_API_KEY BETTER_AUTH_SECRET CALENDAR_TOKEN_ENCRYPTION_KEY CALL_TEXT_KEY DATABASE_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_OAUTH_REDIRECT_URI VOYAGE_API_KEY`. Compare the digest column with every other instance's `fly secrets list`. None may match, except `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on instances that share Looprite's Google client (section 15). Parse on the `│` separator, because the staged list adds `* ` and a STATUS column.

## 12. Deploy

From `server/`, in the worktree, at `main`'s commit with nothing changed:

```zsh
git status --porcelain | wc -l      # expect 0
fly deploy . -c ~/clipwise-teams/<team>/fly.<team>.toml -a <app> --ha=false \
  --label org.opencontainers.image.revision=$(git rev-parse HEAD)
```

`--ha=false` makes one machine. The label records which commit the image was built from.

[CHECK: whether `fly deploy` builds from `server/` when the config file is outside the repo, or looks for the Dockerfile beside the config. The 11-19 build kept the file inside `server/`. Settle on the next build.]

If the deploy fails before the build with a Fly API stream error (`stream error: stream ID 1; INTERNAL_ERROR`), check that nothing was created (`fly machines list` and `fly releases`, both empty), then retry the same command once.

**Check:**

```zsh
fly releases -a <app>          # v1 complete
fly image show -a <app>        # revision = the full hash of HEAD
fly status -a <app>            # 1 machine, started, 1/1 checks passing
fly secrets list -a <app>      # 9 Deployed, 0 Staged
fly logs -a <app> --no-tail    # "call text: key <key id>", "Clipwise server listening on port 3000", "Clipwise app ready"; no "startup: refused"
curl -s https://<app>.fly.dev/live      # {"status":"ok"}
curl -s https://<app>.fly.dev/health    # {"status":"ok","db":"ok"}
```

`call text: key <key id>` shows the call-text key arrived intact. `"db":"ok"` shows `DATABASE_URL` did.

## 13. The address

```zsh
fly ips list -a <app>           # a dedicated v6 and a shared v4
```

At your DNS provider, add two records for `<subdomain>.clipwiseapp.com`: an **A** record to the v4 address and an **AAAA** record to the v6 address. Set both to **DNS only** (on Cloudflare: proxy off). Don't change any other record.

```zsh
dig +short <subdomain>.clipwiseapp.com A       # the v4 address from fly ips list
dig +short <subdomain>.clipwiseapp.com AAAA    # the v6 address
fly certs add <subdomain>.clipwiseapp.com -a <app>
fly certs check <subdomain>.clipwiseapp.com -a <app>     # repeat a minute later until Status = Issued
```

**Check:** `dig` returns Fly's addresses (not your DNS provider's), and `fly certs check` reads `Status = Issued` and `Certificate is verified and active`. Then:

```zsh
curl -s https://<subdomain>.clipwiseapp.com/live      # {"status":"ok"}
curl -s https://<subdomain>.clipwiseapp.com/health    # {"status":"ok","db":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<subdomain>.clipwiseapp.com/mcp    # 401
openssl s_client -connect <subdomain>.clipwiseapp.com:443 -servername <subdomain>.clipwiseapp.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -enddate
```

The certificate's subject is `CN=<subdomain>.clipwiseapp.com`, from Let's Encrypt.

## 14. The team account, the first admin, and the Mac app's sign-in

These commands run **inside the server's machine**, through `fly ssh console`. They use the server's own `DATABASE_URL`, which is the restricted `clipwise_server` login, not the owner. You don't need any connection string on your Mac.

```zsh
fly ssh console -a <app> -C "node /app/dist/auth/cli.js init-account --name '<account name>' --slug <account slug>"
fly ssh console -a <app> -C "node /app/dist/auth/cli.js bootstrap-admin --email <admin email> --name '<admin name>'"
fly ssh console -a <app> -C "node /app/dist/auth/cli.js register-recorder"
fly ssh console -a <app> -C "node /app/dist/auth/cli.js list-members"
```

A name with a space goes in single quotes inside the double-quoted command; `fly ssh console -C` keeps it as one argument.

**Check:**

- `init-account` prints `auth: account created: <account name> (<account slug>) <id>`. An instance has exactly one account.
- `bootstrap-admin` prints `demo: seeded 2 demo call(s) for member=<id>` and `auth: admin added: <admin email>`. Every new member gets two made-up demo calls, visible only to them.
- `register-recorder` prints `auth: recorder client created` with `client_id clipwise-recorder`, `redirect http://127.0.0.1/callback (any port)`, `resource https://<subdomain>.clipwiseapp.com/capture` and `scopes openid offline_access clipwise:capture`. It needs the server to have started once (section 12). The Mac app can't sign in without it.
- `list-members` shows `<admin email>  admin  invited (not signed in yet)`, `notice: none`.

**A second admin.** So the team is never left with one admin, add a second one now. Use the team admin's Mac app later, or run:

```zsh
fly ssh console -a <app> -C "node /app/dist/auth/cli.js add-member --email <second admin email> --role admin --name '<name>'"
```

The other commands (`remove-member`, `delete-member-calls`, `clear-google-tokens`) are for support, not setup. The team admin adds and removes members from the Mac app ([admin-guide.md](admin-guide.md)). `delete-member-calls` deletes every call a removed member owns, work calls included. Run it only for an erasure the team has agreed to. A new instance has nothing for `clear-google-tokens` to do.

## 15. Google sign-in

A Looprite-hosted team uses Looprite's verified Google Cloud project and its web client. Add the team's two redirect URIs to that client: **APIs & Services → Clients →** the web client **→ Authorized redirect URIs**:

```
https://<subdomain>.clipwiseapp.com/api/auth/callback/google
https://<subdomain>.clipwiseapp.com/oauth/google/callback
```

Add no JavaScript origins. Save. Google says a change takes "5 min to a few hours" to take effect.

A team hosting its own creates its own Google Cloud project and web client, with the Calendar API on, and has Google verify it before people outside its own organization sign in.

Publishing status: In production (Google Auth Platform → Audience, seen 2026-11-25).

## 16. Check sign-in

**What the server asks Google for.** This starts a sign-in without finishing it. It leaves one database row that expires by itself.

```zsh
curl -s -X POST https://<subdomain>.clipwiseapp.com/api/auth/sign-in/social \
  -H 'origin: https://<subdomain>.clipwiseapp.com' -H 'content-type: application/json' \
  -d '{"provider":"google","callbackURL":"/login"}' \
| python3 -I -c 'import sys,json,urllib.parse as u; q=u.parse_qs(u.urlparse(json.load(sys.stdin)["url"]).query); [print(k, q.get(k,["(absent)"])[0]) for k in ("redirect_uri","scope","hd","access_type","prompt")]'
```

**Check:**

- `redirect_uri` is `https://<subdomain>.clipwiseapp.com/api/auth/callback/google`.
- `scope` is `email profile openid https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly`, with no `calendar.readonly`.
- `hd` is `<domain>`.
- `access_type` is `offline`, and `prompt` is absent.

**The first sign-in.** The admin, on their own computer with a `<domain>` Google account, opens `https://<subdomain>.clipwiseapp.com/login` and signs in with Google. They should see, in order:

1. **Sign in to clipwiseapp.com**, with Privacy Policy and Terms of Service links, and their name, picture and email. Continue.
2. **clipwiseapp.com wants access to your Google Account**: "See the list of Google calendars you're subscribed to" and "View events on all your calendars". Allow.
3. Back on the instance: "Signed in as `<admin email>`… Your calendar is connected… Your two demo calls are made-up sample recordings, visible only to you."

**There must be no "Google hasn't verified this app" screen.** This is the check that an account outside Looprite signs in cleanly. If that screen appears, stop.

**Check, from the server side:**

```zsh
fly ssh console -a <app> -C "node /app/dist/auth/cli.js list-members"   # <admin email>  admin  active
fly logs -a <app> --no-tail     # "calendar grant: … stored"; no SIGN_IN_DENIED
```

## 17. Claude

Clipwise is used through a connector in Claude. The connector's address is `https://<subdomain>.clipwiseapp.com/mcp`.

The operator or the team's admin adds the connector to the team's Claude organization, so members don't each add it. Each member then connects it and signs in with their own `<domain>` Google account.

[CHECK: the menu names for adding a custom connector to a Claude organization. Settle with screenshots at this step.]

**Check:** the admin turns the connector on in a chat and asks *"In Clipwise, list my calls."* The answer is their two demo calls and nothing else. A member sees only their own calls.

## 18. Hand over to the team's admin

Send the team's admin:

- [admin-guide.md](admin-guide.md), which opens with a prompt to paste into Claude;
- the download link and the full address, `https://<subdomain>.clipwiseapp.com`, so they can install the Mac app with [member-setup.md](member-setup.md).

Tell them: **sharing isn't built for this team.** Every call is visible only to the member who recorded it.

## 19. Every check, in one place

- [ ] §1 Node 22, `npm ci` exit 0, clean worktree with no upstream
- [ ] §3 Fly app created, no machines
- [ ] §4 call-text key: `same`, `32`, an id that differs from every other instance's
- [ ] §5 config file outside the repo; diff from `fly.toml` is only the five keys and their comments
- [ ] §6 Neon project, branch `main`, database `neondb`, role `neondb_owner`
- [ ] §7 0 tables, no `vector`
- [ ] §8 `clipwise_server` with no attributes
- [ ] §9 provision lines as listed, `done: 28 tables in public`, `exit=0`, 0 connection strings and 0 `drop` in the output; BETTER_AUTH_SECRET saved; never changed after this
- [ ] §10 grant: 6 statements dry, BEGIN / 6 / COMMIT; as `clipwise_server`, insert and rollback work, TRUNCATE, CREATE and ALTER refused
- [ ] §11 9 secrets staged, every length non-zero, key id matches, no digest shared with another instance (except the Google client's two, when shared)
- [ ] §12 v1 complete, image revision = HEAD, `call text: key <key id>`, `/live` and `/health` ok
- [ ] §13 DNS gives Fly's addresses, certificate issued, `/live` and `/health` ok on the address, `/mcp` 401
- [ ] §14 one account; admin added with 2 demo calls; recorder client created; second admin added
- [ ] §15 both redirect URIs saved
- [ ] §16 scopes and `hd` as listed; first sign-in has no unverified-app screen; admin `active`; no `SIGN_IN_DENIED`
- [ ] §17 connector in the team's Claude organization; the admin sees only their own calls
- [ ] §18 admin guide, download link and address sent; sharing stated as not built
