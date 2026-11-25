## Linear
Read from Linear freely — issues, comments, docs. Don't write to it: no
comments, no issue state changes, no new issues. When work is done, report
the commit hash and the exact verification output. The chat session records
it in Linear.

## Working rules for Claude Code sessions
- Commits carry the message alone: no Co-Authored-By or other attribution
  trailers, and Claude is not listed as a contributor. This holds whatever a
  session's attribution note says.
- No subagents and no auto mode. Each command is reviewed on its own.
- Anything that builds or runs server or database code (every scratch-db.sh
  command included) happens in a separate git worktree, never in the folder
  the recorder runs from, even when both are at the same commit. If no
  worktree exists, ask rather than fall back to the main checkout.
- When a branch is merged to main, remove its worktree in the same session
  (git worktree remove, never --force), whether or not the issue closes; keep
  the branch, and if the worktree has uncommitted or untracked files, stop and
  ask first. Confirm the folder is gone with a check that doesn't go through
  git (test -e).
- A check or test run never uses the installed app's identity: not its app
  name, not its keychain item, not its support folder.
- A push is confirmed by reading the remote ref, not by the push output.
- A durable memory write is proposed in full and approved before it lands.
- Credentials never go in chat or in the repo.

## Database schema (server/src/db/schema.ts)
- Jon runs `npm run db:push` himself, in Terminal, from a worktree at main's
  HEAD. Before he does, Claude Code lists the exact statements the plan
  should show; anything else in the plan means No.
- CHECK constraints: drizzle-kit push (0.31) adds a CHECK under a new name
  but ignores a changed definition under an existing name, and `db:checks`
  skips any name that exists. After any push, read the live definition back
  with `pg_get_constraintdef`, never from push output.
- A CHECK passes when its expression is null. A nullable column tested with
  `IN (...)` also needs `IS NOT NULL`, or a null value gets through.
- To change an existing CHECK, follow the repo's precedent (the
  jobs_kind_allowed comment in schema.ts): give it a new name, then confirm
  with `pg_get_constraintdef` that the live database has exactly the
  definitions schema.ts declares. Whether push drops the old name is not
  verified here; look for it in that read-back.

## Recorder app (recorder/app/)
The packaged app at `recorder/app/dist/Clipwise.app` runs a copy of `main.js`,
`identity.html` and `identity-answer.js`, not the files in the checkout. The
same holds for each window's page script and preload (`identity-page.js`,
`identity-preload.js`, `meetings-page.js`, `meetings-preload.js`,
`setup-page.js`, `setup-preload.js`, `voice-prints-page.js`,
`voice-prints-preload.js`, `prompt-panel-page.js`, `prompt-panel-preload.js`)
and for `identity-rules.js`, `capture-sign-in.js`, `detect-answer.js`,
`prompt-panel.js`, `prompt-panel.html`, and the admin's Team members window
(`team-notice.js`, `team-notice.html`, `team-notice-page.js`,
`team-notice-preload.js`). After
any change to those, run `recorder/app/build-app.sh` AND relaunch the app —
the running bundle keeps the code it was built from. Symptom of skipping it is
an edit that changes nothing: the prompt, the stop path or the hotkeys behave
exactly as they did before.
